import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const PARTICIPANT_ID = "local.gemini-vscode-agent";
const PARTICIPANT_NAME = "gemini";
const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_TOOL_ITERATIONS = 8;
const API_KEY_SECRET = "geminiAgent.apiKey";

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

type ToolResultPayload = {
  ok: boolean;
  content?: unknown;
  error?: string;
};

type ToolExecutionContext = {
  stream: vscode.ChatResponseStream;
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

export function activate(context: vscode.ExtensionContext): void {
  extensionContextRef = context;

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, stream, token) => {
    try {
      await handleChatRequest(request, chatContext, stream, token);
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
      await ensureApiKeyInteractive();
      await openNativeChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("geminiAgent.resetSession", async () => {
      try {
        await vscode.commands.executeCommand("workbench.action.chat.new");
      } catch {
        await openNativeChat();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("geminiAgent.setApiKey", async () => {
      await promptAndStoreApiKey();
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
}

export function deactivate(): void {}

async function handleChatRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  await ensureApiKeyInteractive();
  const conversation = buildConversation(context, request);

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

function buildConversation(context: vscode.ChatContext, request: vscode.ChatRequest): GeminiContent[] {
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

  const prompt = buildPromptWithReferences(request);
  conversation.push({
    role: "user",
    parts: [{ text: prompt }]
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

async function generateGemini(contents: GeminiContent[], token: vscode.CancellationToken): Promise<GeminiResponse> {
  const response = await fetchGemini("generateContent", contents, token);
  return (await response.json()) as GeminiResponse;
}

async function streamGemini(
  contents: GeminiContent[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<string> {
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

      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");

      if (data && data !== "[DONE]") {
        const payload = JSON.parse(data) as GeminiResponse;
        const candidate = payload.candidates?.[0];
        const content = candidate?.content;
        if (content) {
          for (const part of content.parts) {
            if ("text" in part && part.text) {
              aggregatedText += part.text;
              stream.markdown(part.text);
            }
          }
        }
      }

      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  const trailing = buffer.trim();
  if (trailing.startsWith("data:")) {
    const data = trailing
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");

    if (data && data !== "[DONE]") {
      const payload = JSON.parse(data) as GeminiResponse;
      const content = payload.candidates?.[0]?.content;
      if (content) {
        for (const part of content.parts) {
          if ("text" in part && part.text) {
            aggregatedText += part.text;
            stream.markdown(part.text);
          }
        }
      }
    }
  }

  return aggregatedText;
}

async function fetchGemini(
  endpoint: "generateContent" | "streamGenerateContent?alt=sse",
  contents: GeminiContent[],
  token: vscode.CancellationToken
): Promise<Response> {
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

  const action = await vscode.window.showInformationMessage(
    "Gemini API key is not configured.",
    "Set API Key"
  );

  if (action === "Set API Key") {
    await promptAndStoreApiKey();
  }
}

async function getApiKeyOptional(): Promise<string | undefined> {
  const secretApiKey = extensionContextRef ? await extensionContextRef.secrets.get(API_KEY_SECRET) : undefined;
  return secretApiKey || vscode.workspace.getConfiguration("geminiAgent").get<string>("apiKey") || process.env.GEMINI_API_KEY || undefined;
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
