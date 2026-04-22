import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const PARTICIPANT_ID = "local.gemini-vscode-agent";
const PARTICIPANT_NAME = "gemini";
const WEBVIEW_ID = "geminiAgent.sidebar";
const API_KEY_SECRET = "geminiAgent.apiKey";
const BASE_URL_SECRET = "geminiAgent.baseUrl";
const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_TOOL_ITERATIONS = 8;

const SYSTEM_PROMPT = [
  "You are a coding agent running inside Visual Studio Code.",
  "You can inspect and edit local files by calling tools.",
  "Read files before making changes, keep edits precise, and do not invent file contents.",
  "Prefer focused reads over broad scans unless the user asked for exploration.",
  "If a tool fails, explain the constraint briefly and adapt."
].join(" ");

type GeminiTextPart = { text: string };
type GeminiFunctionCallPart = {
  functionCall: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
};
type GeminiFunctionResponsePart = {
  functionResponse: {
    id?: string;
    name: string;
    response: unknown;
  };
};
type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiCandidate = {
  content?: GeminiContent;
  finishReason?: string;
};

type GeminiResponse = {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    blockReason?: string;
  };
  error?: {
    message?: string;
  };
};

type OpenAIChatMessage =
  | { role: "system" | "user" | "assistant"; content?: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; content: string; tool_call_id: string };

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
  };
};

type ToolResultPayload = {
  ok: boolean;
  content?: unknown;
  error?: string;
};

type ChatLogMessage = {
  role: "user" | "assistant" | "system";
  text: string;
};

type AgentStream = {
  markdown(value: string): void;
  progress(value: string): void;
};

type ToolExecutionContext = {
  stream: AgentStream;
  token: vscode.CancellationToken;
};

type ListFilesInput = {
  targetPath?: string;
  recursive?: boolean;
  maxEntries?: number;
};

type ReadFileInput = {
  targetPath: string;
  startLine?: number;
  endLine?: number;
};

type WriteFileInput = {
  targetPath: string;
  content: string;
};

type SearchTextInput = {
  pattern: string;
  targetPath?: string;
  maxResults?: number;
};

const TOOL_DECLARATIONS = [
  {
    name: "list_files",
    description: "List files and folders inside a directory. Use this to explore the workspace before reading specific files.",
    parameters: {
      type: "object",
      properties: {
        targetPath: {
          type: "string",
          description: "Relative path from workspace root or an absolute path if allowed. Use '.' for the workspace root."
        },
        recursive: {
          type: "boolean",
          description: "Whether to recurse into child folders."
        },
        maxEntries: {
          type: "number",
          description: "Maximum number of entries to return."
        }
      }
    }
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file and optionally limit the response to a line range.",
    parameters: {
      type: "object",
      properties: {
        targetPath: {
          type: "string",
          description: "Relative path from workspace root or an absolute path if allowed."
        },
        startLine: {
          type: "number",
          description: "1-based inclusive start line."
        },
        endLine: {
          type: "number",
          description: "1-based inclusive end line."
        }
      },
      required: ["targetPath"]
    }
  },
  {
    name: "write_file",
    description: "Write full UTF-8 text content to a file, creating parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        targetPath: {
          type: "string",
          description: "Relative path from workspace root or an absolute path if allowed."
        },
        content: {
          type: "string",
          description: "The full file content to write."
        }
      },
      required: ["targetPath", "content"]
    }
  },
  {
    name: "search_text",
    description: "Search for a plain text substring inside text files.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Plain text pattern to search for."
        },
        targetPath: {
          type: "string",
          description: "Relative directory from workspace root or absolute path if allowed."
        },
        maxResults: {
          type: "number",
          description: "Maximum number of matches to return."
        }
      },
      required: ["pattern"]
    }
  }
];

let extensionContextRef: vscode.ExtensionContext | undefined;

class GeminiSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly chatLog: ChatLogMessage[] = [];
  private readonly conversation: GeminiContent[] = [];
  private activeRequest?: vscode.CancellationTokenSource;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "send") {
        await this.handlePrompt(String(message.text ?? ""));
      } else if (message.type === "reset") {
        this.reset();
      } else if (message.type === "setApiKey") {
        await promptAndStoreApiKey();
        this.postState();
      } else if (message.type === "setBaseUrl") {
        await promptAndStoreBaseUrl();
        this.postState();
      } else if (message.type === "stop") {
        this.activeRequest?.cancel();
      }
    });
    this.postState();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.geminiAgent");
    await vscode.commands.executeCommand(`${WEBVIEW_ID}.focus`);
  }

  reset(): void {
    this.activeRequest?.cancel();
    this.chatLog.length = 0;
    this.conversation.length = 0;
    this.chatLog.push({
      role: "system",
      text: "Session reset."
    });
    this.postState(false);
  }

  private async handlePrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    await ensureProviderConfigInteractive();

    const cancellation = new vscode.CancellationTokenSource();
    this.activeRequest?.cancel();
    this.activeRequest = cancellation;

    this.chatLog.push({ role: "user", text: trimmed });
    this.postState(true);

    const prompt = trimmed;
    this.conversation.push({
      role: "user",
      parts: [{ text: prompt }]
    });

    const replyIndex = this.chatLog.push({ role: "assistant", text: "" }) - 1;
    const sink = this.createWebviewStream(replyIndex);

    try {
      await runGeminiConversation(this.conversation, sink, cancellation.token);
      if (!this.chatLog[replyIndex].text.trim()) {
        this.chatLog[replyIndex].text = "No response.";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.chatLog[replyIndex].text.trim()) {
        this.chatLog[replyIndex].text = `Error: ${message}`;
      } else {
        this.chatLog[replyIndex].text += `\n\nError: ${message}`;
      }
    } finally {
      if (this.activeRequest === cancellation) {
        this.activeRequest = undefined;
      }
      this.postState(false);
      cancellation.dispose();
    }
  }

  private createWebviewStream(replyIndex: number): AgentStream {
    return {
      markdown: (value: string) => {
        this.chatLog[replyIndex].text += value;
        this.postState(true);
      },
      progress: (value: string) => {
        this.postState(true, value);
      }
    };
  }

  private postState(busy = false, status?: string): void {
    this.view?.webview.postMessage({
      type: "state",
      messages: this.chatLog,
      busy,
      status: status ?? (busy ? "Working..." : "Ready"),
      hasApiKey: undefined
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a1020;
      --panel: #10182c;
      --panel-2: #18233d;
      --border: rgba(148, 163, 184, 0.18);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #7dd3fc;
      --accent-2: #38bdf8;
      --user: #0f766e;
      --assistant: #1d4ed8;
      --system: #475569;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Consolas, "Courier New", monospace;
      color: var(--text);
      background:
        radial-gradient(circle at top, rgba(56, 189, 248, 0.18), transparent 32%),
        linear-gradient(180deg, #08101c, var(--bg));
      height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    .header {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      background: rgba(10, 16, 32, 0.92);
      backdrop-filter: blur(8px);
    }
    .title {
      display: grid;
      gap: 2px;
    }
    .title strong {
      color: var(--accent);
      font-size: 13px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .title span {
      color: var(--muted);
      font-size: 11px;
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    button {
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      border-radius: 10px;
      padding: 7px 10px;
      cursor: pointer;
      font: inherit;
    }
    button.primary {
      background: linear-gradient(180deg, rgba(56, 189, 248, 0.18), rgba(29, 78, 216, 0.28));
      border-color: rgba(56, 189, 248, 0.35);
    }
    .messages {
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .message {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
      padding: 12px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--panel);
    }
    .message[data-role="user"] {
      background: rgba(15, 118, 110, 0.14);
      border-left: 4px solid var(--user);
    }
    .message[data-role="assistant"] {
      background: rgba(29, 78, 216, 0.12);
      border-left: 4px solid var(--assistant);
    }
    .message[data-role="system"] {
      color: var(--muted);
      border-left: 4px solid var(--system);
    }
    .composer {
      padding: 12px;
      border-top: 1px solid var(--border);
      display: grid;
      gap: 10px;
      background: rgba(10, 16, 32, 0.95);
    }
    textarea {
      width: 100%;
      min-height: 110px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px;
      color: var(--text);
      background: var(--panel-2);
      font: inherit;
    }
    .footer {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }
    .status {
      color: var(--muted);
      font-size: 12px;
      min-height: 16px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">
      <strong>Gemini Agent</strong>
      <span>Separate sidebar chat with local file access</span>
    </div>
    <div class="actions">
        <button id="setBaseUrl">Endpoint</button>
        <button id="setApiKey">API Key</button>
      <button id="reset">Reset</button>
    </div>
  </div>
  <div class="messages" id="messages"></div>
  <div class="composer">
    <textarea id="input" placeholder="Ask Gemini to inspect, search, or change your files"></textarea>
    <div class="footer">
      <div class="status" id="status">Ready</div>
      <div class="actions">
        <button id="stop">Stop</button>
        <button class="primary" id="send">Send</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const statusEl = document.getElementById("status");

    function send() {
      const text = inputEl.value;
      if (!text.trim()) {
        return;
      }
      vscode.postMessage({ type: "send", text });
      inputEl.value = "";
    }

    document.getElementById("send").addEventListener("click", send);
    document.getElementById("reset").addEventListener("click", () => vscode.postMessage({ type: "reset" }));
    document.getElementById("setBaseUrl").addEventListener("click", () => vscode.postMessage({ type: "setBaseUrl" }));
    document.getElementById("setApiKey").addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
    document.getElementById("stop").addEventListener("click", () => vscode.postMessage({ type: "stop" }));

    inputEl.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        send();
      }
    });

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (data.type !== "state") {
        return;
      }

      statusEl.textContent = data.status;
      messagesEl.innerHTML = "";
      for (const message of data.messages) {
        const item = document.createElement("div");
        item.className = "message";
        item.dataset.role = message.role;
        item.textContent = message.text;
        messagesEl.appendChild(item);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContextRef = context;

  const sidebarProvider = new GeminiSidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WEBVIEW_ID, sidebarProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, stream, token) => {
    try {
      await ensureProviderConfigInteractive();
      const conversation = buildConversationFromChat(chatContext, request);
      await runGeminiConversation(conversation, createChatResponseStream(stream), token);
      return {
        metadata: {
          model: getModel(),
          completedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        errorDetails: {
          message
        }
      };
    }
  });

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "gemini.svg");
  context.subscriptions.push(participant);

  context.subscriptions.push(
    vscode.commands.registerCommand("geminiAgent.openChat", async () => {
      await ensureProviderConfigInteractive();
      await sidebarProvider.reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("geminiAgent.openNativeChat", async () => {
      await ensureProviderConfigInteractive();
      await openNativeChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("geminiAgent.resetSession", async () => {
      sidebarProvider.reset();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("geminiAgent.setApiKey", async () => {
      await promptAndStoreApiKey();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("geminiAgent.setBaseUrl", async () => {
      await promptAndStoreBaseUrl();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("geminiAgent.clearApiKey", async () => {
      if (!extensionContextRef) {
        return;
      }
      await extensionContextRef.secrets.delete(API_KEY_SECRET);
      void vscode.window.showInformationMessage("Gemini API key removed from secure storage.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("geminiAgent.clearBaseUrl", async () => {
      if (!extensionContextRef) {
        return;
      }
      await extensionContextRef.secrets.delete(BASE_URL_SECRET);
      void vscode.window.showInformationMessage("Custom base URL removed.");
    })
  );
}

export function deactivate(): void {}

function buildConversationFromChat(context: vscode.ChatContext, request: vscode.ChatRequest): GeminiContent[] {
  const conversation: GeminiContent[] = [];

  for (const turn of context.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      conversation.push({
        role: "user",
        parts: [{ text: turn.prompt }]
      });
      continue;
    }

    if (turn instanceof vscode.ChatResponseTurn && turn.participant === PARTICIPANT_ID) {
      const text = turn.response
        .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
        .map((part) => part.value.value)
        .join("");

      if (text.trim()) {
        conversation.push({
          role: "model",
          parts: [{ text }]
        });
      }
    }
  }

  conversation.push({
    role: "user",
    parts: [{ text: buildPromptWithReferences(request) }]
  });

  return conversation;
}

function buildPromptWithReferences(request: vscode.ChatRequest): string {
  const lines = [request.prompt.trim()];

  for (const reference of request.references) {
    if (reference.value instanceof vscode.Uri) {
      lines.push(`Referenced URI: ${reference.value.fsPath || reference.value.toString()}`);
    } else if (reference.value instanceof vscode.Location) {
      lines.push(`Referenced location: ${reference.value.uri.fsPath}:${reference.value.range.start.line + 1}`);
    } else if (typeof reference.value === "string") {
      lines.push(`Referenced value: ${reference.value}`);
    }
  }

  return lines.filter(Boolean).join("\n");
}

function createChatResponseStream(stream: vscode.ChatResponseStream): AgentStream {
  return {
    markdown: (value: string) => stream.markdown(value),
    progress: (value: string) => stream.progress(value)
  };
}

async function runGeminiConversation(
  conversation: GeminiContent[],
  stream: AgentStream,
  token: vscode.CancellationToken
): Promise<void> {
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    throwIfCancelled(token);
    if (iteration === 0) {
      stream.progress(`Connecting to Gemini ${getModel()}`);
    }

    const inspection = await generateGemini(conversation, token);
    const candidate = inspection.candidates?.[0];
    const content = candidate?.content;

    if (!content) {
      const blockReason = inspection.promptFeedback?.blockReason;
      throw new Error(blockReason ? `Gemini blocked the request: ${blockReason}` : "Gemini returned no candidate content.");
    }

    const functionCalls = getFunctionCalls(content);
    if (functionCalls.length === 0) {
      const finalText = await streamGemini(conversation, stream, token);
      if (!finalText.trim()) {
        const fallbackText = getTextFromContent(content);
        if (!fallbackText.trim()) {
          throw new Error(candidate?.finishReason ? `Gemini finished without text: ${candidate.finishReason}` : "Gemini finished without text.");
        }
        stream.markdown(fallbackText);
        conversation.push({
          role: "model",
          parts: [{ text: fallbackText }]
        });
      } else {
        conversation.push({
          role: "model",
          parts: [{ text: finalText }]
        });
      }
      return;
    }

    conversation.push(content);
    const toolParts: GeminiPart[] = [];
    for (const call of functionCalls) {
      throwIfCancelled(token);
      stream.progress(`Running ${call.name}`);
      const result = await executeTool(call.name, call.args ?? {}, { stream, token });
      toolParts.push({
        functionResponse: {
          id: call.id,
          name: call.name,
          response: result
        }
      });
    }

    conversation.push({
      role: "user",
      parts: toolParts
    });
  }

  throw new Error("Gemini exceeded the tool-call iteration limit.");
}

async function generateGemini(contents: GeminiContent[], token: vscode.CancellationToken): Promise<GeminiResponse> {
  const response = await fetchGemini("generateContent", contents, token);
  if (await isOpenAICompatibleMode()) {
    const payload = (await response.json()) as OpenAIResponse;
    return fromOpenAIResponse(payload);
  }
  return (await response.json()) as GeminiResponse;
}

async function streamGemini(contents: GeminiContent[], stream: AgentStream, token: vscode.CancellationToken): Promise<string> {
  const response = await fetchGemini("streamGenerateContent?alt=sse", contents, token);
  const body = response.body;

  if (!body) {
    throw new Error("Gemini streaming response body is missing.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let aggregatedText = "";

  while (true) {
    throwIfCancelled(token);
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      aggregatedText += emitSseEvent(rawEvent, stream);
      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  const trailing = buffer.trim();
  if (trailing.startsWith("data:")) {
    aggregatedText += emitSseEvent(trailing, stream);
  }

  return aggregatedText;
}

function emitSseEvent(rawEvent: string, stream: AgentStream): string {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");

  if (!data || data === "[DONE]") {
    return "";
  }

  const payload = JSON.parse(data) as GeminiResponse | OpenAIResponse;
  if (isOpenAIChunk(payload)) {
    const text = payload.choices?.[0]?.delta?.content ?? "";
    if (text) {
      stream.markdown(text);
    }
    return text;
  }

  const content = (payload as GeminiResponse).candidates?.[0]?.content;
  if (!content) {
    return "";
  }

  let text = "";
  for (const part of content.parts) {
    if ("text" in part && part.text) {
      text += part.text;
      stream.markdown(part.text);
    }
  }
  return text;
}

async function fetchGemini(
  endpoint: "generateContent" | "streamGenerateContent?alt=sse",
  contents: GeminiContent[],
  token: vscode.CancellationToken
): Promise<Response> {
  if (await isOpenAICompatibleMode()) {
    return fetchOpenAICompatible(contents, endpoint === "streamGenerateContent?alt=sse", token);
  }

  const apiKey = await getApiKey();
  const model = getModel();
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents,
        tools: [
          {
            functionDeclarations: TOOL_DECLARATIONS
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as GeminiResponse | undefined;
      throw new Error(payload?.error?.message || `Gemini API request failed with status ${response.status}.`);
    }

    return response;
  } finally {
    subscription.dispose();
  }
}

async function fetchOpenAICompatible(
  contents: GeminiContent[],
  stream: boolean,
  token: vscode.CancellationToken
): Promise<Response> {
  const apiKey = await getApiKey();
  const model = getModel();
  const baseUrl = await getBaseUrl();
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());

  try {
    const response = await fetch(joinUrl(baseUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(contents),
        tools: TOOL_DECLARATIONS.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        })),
        tool_choice: "auto",
        stream
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as OpenAIResponse | undefined;
      throw new Error(payload?.error?.message || `OpenAI-compatible API request failed with status ${response.status}.`);
    }

    return response;
  } finally {
    subscription.dispose();
  }
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  toolContext: ToolExecutionContext
): Promise<ToolResultPayload> {
  try {
    switch (name) {
      case "list_files":
        return { ok: true, content: await listFiles(args as ListFilesInput, toolContext.token) };
      case "read_file":
        return { ok: true, content: await readFileTool(args as ReadFileInput, toolContext.token) };
      case "write_file":
        return { ok: true, content: await writeFileTool(args as WriteFileInput, toolContext) };
      case "search_text":
        return { ok: true, content: await searchTextTool(args as SearchTextInput, toolContext.token) };
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function listFiles(input: ListFilesInput, token: vscode.CancellationToken): Promise<unknown> {
  const target = await resolveTargetPath(input.targetPath ?? ".");
  const recursive = input.recursive ?? false;
  const maxEntries = clampNumber(input.maxEntries, 1, 1000, 200);
  const entries: Array<{ path: string; type: "file" | "directory" }> = [];

  async function walk(currentPath: string): Promise<void> {
    throwIfCancelled(token);
    const children = await fs.readdir(currentPath, { withFileTypes: true });
    for (const child of children) {
      if (entries.length >= maxEntries) {
        return;
      }

      const absolute = path.join(currentPath, child.name);
      entries.push({
        path: normalizeForDisplay(absolute),
        type: child.isDirectory() ? "directory" : "file"
      });

      if (recursive && child.isDirectory()) {
        await walk(absolute);
      }
    }
  }

  await walk(target);
  return {
    root: normalizeForDisplay(target),
    count: entries.length,
    entries
  };
}

async function readFileTool(input: ReadFileInput, token: vscode.CancellationToken): Promise<unknown> {
  const target = await resolveTargetPath(requireNonEmptyString(input.targetPath, "targetPath"));
  throwIfCancelled(token);

  const stat = await fs.stat(target);
  const maxFileBytes = getMaxFileBytes();
  if (stat.size > maxFileBytes) {
    throw new Error(`File is too large to read in one call (${stat.size} bytes > ${maxFileBytes}).`);
  }

  const content = await fs.readFile(target, "utf8");
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(1, Math.floor(input.startLine ?? 1));
  const endLine = Math.min(lines.length, Math.floor(input.endLine ?? lines.length));

  return {
    path: normalizeForDisplay(target),
    startLine,
    endLine,
    content: lines.slice(startLine - 1, endLine).join("\n")
  };
}

async function writeFileTool(input: WriteFileInput, toolContext: ToolExecutionContext): Promise<unknown> {
  const targetPath = requireNonEmptyString(input.targetPath, "targetPath");
  const content = requireString(input.content, "content");
  const resolved = await resolveTargetPath(targetPath, true);
  const analysis = await analyzeWriteTarget(resolved);

  if (shouldConfirmDangerousWrite(analysis)) {
    toolContext.stream.progress(`Waiting for confirmation to write ${normalizeForDisplay(resolved)}`);
    const reasonText = analysis.reasons.map((reason) => `- ${reason}`).join("\n");
    const confirmation = await vscode.window.showWarningMessage(
      `Gemini wants to write ${normalizeForDisplay(resolved)}.\n${reasonText}`,
      { modal: true },
      "Continue"
    );

    if (confirmation !== "Continue") {
      throw new Error("User rejected the write operation.");
    }
  }

  throwIfCancelled(toolContext.token);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf8");

  return {
    path: normalizeForDisplay(resolved),
    bytesWritten: Buffer.byteLength(content, "utf8"),
    existedBeforeWrite: analysis.exists
  };
}

async function searchTextTool(input: SearchTextInput, token: vscode.CancellationToken): Promise<unknown> {
  const pattern = requireNonEmptyString(input.pattern, "pattern");
  const target = await resolveTargetPath(input.targetPath ?? ".");
  const maxResults = clampNumber(input.maxResults, 1, 500, 100);
  const matches: Array<{ path: string; line: number; text: string }> = [];

  async function walk(currentPath: string): Promise<void> {
    throwIfCancelled(token);
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= maxResults) {
        return;
      }

      const absolute = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      try {
        const stat = await fs.stat(absolute);
        if (stat.size > getMaxFileBytes()) {
          continue;
        }

        const content = await fs.readFile(absolute, "utf8");
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].includes(pattern)) {
            matches.push({
              path: normalizeForDisplay(absolute),
              line: index + 1,
              text: lines[index]
            });
            if (matches.length >= maxResults) {
              return;
            }
          }
        }
      } catch {
        continue;
      }
    }
  }

  await walk(target);
  return {
    pattern,
    root: normalizeForDisplay(target),
    count: matches.length,
    matches
  };
}

async function analyzeWriteTarget(resolvedPath: string): Promise<{ exists: boolean; outsideWorkspace: boolean; reasons: string[] }> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const reasons: string[] = [];
  let exists = false;

  try {
    await fs.access(resolvedPath);
    exists = true;
  } catch {
    exists = false;
  }

  const outsideWorkspace = workspaceFolder ? isOutsideWorkspace(resolvedPath, workspaceFolder) : true;
  if (exists) {
    reasons.push("the target file already exists and will be overwritten");
  }
  if (outsideWorkspace) {
    reasons.push("the target path is outside the current workspace");
  }

  return {
    exists,
    outsideWorkspace,
    reasons
  };
}

function shouldConfirmDangerousWrite(analysis: { reasons: string[] }): boolean {
  const enabled = vscode.workspace.getConfiguration("geminiAgent").get<boolean>("confirmDangerousWrites", true);
  return enabled && analysis.reasons.length > 0;
}

async function resolveTargetPath(inputPath: string, forWrite = false): Promise<string> {
  const allowOutsideWorkspace = vscode.workspace.getConfiguration("geminiAgent").get<boolean>("allowOutsideWorkspace", false);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const basePath = workspaceFolder ?? process.cwd();
  const resolved = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(basePath, inputPath));

  if (!allowOutsideWorkspace && workspaceFolder && isOutsideWorkspace(resolved, workspaceFolder)) {
    throw new Error("Path is outside the current workspace. Enable geminiAgent.allowOutsideWorkspace to allow this.");
  }

  if (!forWrite) {
    await fs.access(resolved);
  }

  return resolved;
}

function isOutsideWorkspace(targetPath: string, workspaceFolder: string): boolean {
  const relative = path.relative(workspaceFolder, targetPath);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function normalizeForDisplay(absolutePath: string): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    return absolutePath;
  }

  const relative = path.relative(workspaceFolder, absolutePath);
  return relative && !relative.startsWith("..") ? relative.replace(/\\/g, "/") : absolutePath;
}

function getFunctionCalls(content: GeminiContent): Array<{ id?: string; name: string; args?: Record<string, unknown> }> {
  return content.parts
    .map((part) => ("functionCall" in part ? part.functionCall : undefined))
    .filter((part): part is NonNullable<typeof part> => Boolean(part));
}

function toOpenAIMessages(contents: GeminiContent[]): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [
    {
      role: "system",
      content: SYSTEM_PROMPT
    }
  ];

  for (const content of contents) {
    const text = content.parts.filter((part): part is GeminiTextPart => "text" in part).map((part) => part.text).join("");
    const functionCalls = content.parts
      .filter((part): part is GeminiFunctionCallPart => "functionCall" in part)
      .map((part) => part.functionCall);
    const functionResponses = content.parts
      .filter((part): part is GeminiFunctionResponsePart => "functionResponse" in part)
      .map((part) => part.functionResponse);

    if (content.role === "model") {
      if (functionCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: functionCalls.map((call, index) => ({
            id: call.id ?? `tool_call_${Date.now()}_${index}`,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args ?? {})
            }
          }))
        });
      } else {
        messages.push({
          role: "assistant",
          content: text
        });
      }
      continue;
    }

    if (functionResponses.length > 0) {
      for (const response of functionResponses) {
        messages.push({
          role: "tool",
          tool_call_id: response.id ?? `tool_result_${Date.now()}`,
          content: JSON.stringify(response.response)
        });
      }
    } else {
      messages.push({
        role: "user",
        content: text
      });
    }
  }

  return messages;
}

function fromOpenAIResponse(payload: OpenAIResponse): GeminiResponse {
  const message = payload.choices?.[0]?.message;
  const parts: GeminiPart[] = [];

  if (message?.content) {
    parts.push({ text: message.content });
  }

  for (const toolCall of message?.tool_calls ?? []) {
    let args: Record<string, unknown> | undefined;
    try {
      args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      args = {};
    }

    parts.push({
      functionCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        args
      }
    });
  }

  return {
    candidates: [
      {
        content: {
          role: "model",
          parts
        },
        finishReason: payload.choices?.[0]?.finish_reason ?? undefined
      }
    ],
    error: payload.error
  };
}

function isOpenAIChunk(payload: GeminiResponse | OpenAIResponse): payload is OpenAIResponse {
  return Array.isArray((payload as OpenAIResponse).choices) && !(payload as GeminiResponse).candidates;
}

function getTextFromContent(content: GeminiContent): string {
  return content.parts.map((part) => ("text" in part ? part.text : "")).join("");
}

async function getApiKey(): Promise<string> {
  const apiKey = await getApiKeyOptional();
  if (!apiKey) {
    throw new Error("Gemini API key is not configured. Run 'Gemini Agent: Set API Key' or set GEMINI_API_KEY.");
  }
  return apiKey;
}

function getModel(): string {
  return vscode.workspace.getConfiguration("geminiAgent").get<string>("model", DEFAULT_MODEL);
}

function getMaxFileBytes(): number {
  return vscode.workspace.getConfiguration("geminiAgent").get<number>("maxFileBytes", 200000);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool argument "${field}" must be a non-empty string.`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Tool argument "${field}" must be a string.`);
  }
  return value;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new Error("Request cancelled.");
  }
}

async function openNativeChat(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.chat.open", {
      query: `@${PARTICIPANT_NAME} `,
      isPartialQuery: true
    });
  } catch {
    await vscode.commands.executeCommand("workbench.action.chat.open");
    void vscode.window.showInformationMessage(`Open Chat and use @${PARTICIPANT_NAME}.`);
  }
}

async function ensureApiKeyInteractive(): Promise<void> {
  const apiKey = await getApiKeyOptional();
  if (apiKey) {
    return;
  }

  const action = await vscode.window.showInformationMessage("Gemini API key is not configured.", "Set API Key");
  if (action === "Set API Key") {
    await promptAndStoreApiKey();
  }
}

async function ensureProviderConfigInteractive(): Promise<void> {
  if (await isOpenAICompatibleMode()) {
    const baseUrl = await getBaseUrlOptional();
    if (!baseUrl) {
      const action = await vscode.window.showInformationMessage("Base URL is not configured for OpenAI-compatible mode.", "Set Base URL");
      if (action === "Set Base URL") {
        await promptAndStoreBaseUrl();
      }
    }
  }

  await ensureApiKeyInteractive();
}

async function getApiKeyOptional(): Promise<string | undefined> {
  const secretApiKey = extensionContextRef ? await extensionContextRef.secrets.get(API_KEY_SECRET) : undefined;
  return secretApiKey || vscode.workspace.getConfiguration("geminiAgent").get<string>("apiKey") || process.env.GEMINI_API_KEY || undefined;
}

async function getBaseUrl(): Promise<string> {
  const baseUrl = await getBaseUrlOptional();
  if (!baseUrl) {
    throw new Error("Base URL is not configured. Run 'Gemini Agent: Set Base URL'.");
  }
  return baseUrl;
}

async function getBaseUrlOptional(): Promise<string | undefined> {
  const secretBaseUrl = extensionContextRef ? await extensionContextRef.secrets.get(BASE_URL_SECRET) : undefined;
  return secretBaseUrl || vscode.workspace.getConfiguration("geminiAgent").get<string>("baseUrl") || process.env.GEMINI_BASE_URL || undefined;
}

async function isOpenAICompatibleMode(): Promise<boolean> {
  const style = vscode.workspace.getConfiguration("geminiAgent").get<string>("apiStyle", "gemini");
  if (style === "openai-compatible") {
    return true;
  }
  return false;
}

async function promptAndStoreApiKey(): Promise<void> {
  if (!extensionContextRef) {
    throw new Error("Extension context is not initialized.");
  }

  const existing = await getApiKeyOptional();
  const input = await vscode.window.showInputBox({
    title: "Gemini API Key",
    prompt: "Paste your Gemini API key",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "AIza...",
    value: existing ?? ""
  });

  if (input === undefined) {
    return;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("API key input was empty.");
  }

  await extensionContextRef.secrets.store(API_KEY_SECRET, trimmed);
  void vscode.window.showInformationMessage("Gemini API key saved in secure storage.");
}

async function promptAndStoreBaseUrl(): Promise<void> {
  if (!extensionContextRef) {
    throw new Error("Extension context is not initialized.");
  }

  const existing = await getBaseUrlOptional();
  const input = await vscode.window.showInputBox({
    title: "API Base URL",
    prompt: "Paste your OpenAI-compatible base URL",
    ignoreFocusOut: true,
    placeHolder: "https://agent.timeweb.cloud/api/v1/cloud-ai/agents/<agent_id>",
    value: existing ?? ""
  });

  if (input === undefined) {
    return;
  }

  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Base URL input was empty.");
  }

  await extensionContextRef.secrets.store(BASE_URL_SECRET, trimmed);
  void vscode.window.showInformationMessage("API base URL saved in secure storage.");
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 16; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
