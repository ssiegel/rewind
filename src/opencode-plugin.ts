import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type ToastVariant = "info" | "success" | "warning" | "error";

type RewindCommandPart = {
  type?: string;
  text?: string;
  ignored?: boolean;
  synthetic?: boolean;
  [key: string]: unknown;
};

type CommandExecuteBeforeInput = {
  command: string;
  sessionID: string;
  arguments: string;
};

type CommandExecuteBeforeOutput = {
  parts: RewindCommandPart[];
};

type PluginClient = {
  tui?: {
    showToast(args: {
      body: {
        message: string;
        variant: ToastVariant;
        duration?: number;
      };
    }): Promise<unknown>;
  };
};

type PluginShell = {
  (strings: TemplateStringsArray, ...values: unknown[]): {
    quiet(): Promise<unknown>;
  };
};

type PluginInput = {
  client: PluginClient;
  $: PluginShell;
};

export interface RewindPluginOptions {
  baseUrl?: string;
  rewindCommand?: string;
  stopCommand?: string;
  cliCommand?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3838";
const DEFAULT_REWIND_COMMAND = "rewind";
const DEFAULT_STOP_COMMAND = "rewind-off";
const DEFAULT_CLI_COMMAND = fileURLToPath(new URL("../bin/opencode-rewind.js", import.meta.url));

function resolveOptions(options?: RewindPluginOptions) {
  return {
    baseUrl: options?.baseUrl || DEFAULT_BASE_URL,
    rewindCommand: options?.rewindCommand || DEFAULT_REWIND_COMMAND,
    stopCommand: options?.stopCommand || DEFAULT_STOP_COMMAND,
    cliCommand: options?.cliCommand || DEFAULT_CLI_COMMAND,
  };
}

function parseBaseUrl(baseUrl: string): URL {
  const parsed = new URL(baseUrl);
  if (!parsed.port) {
    parsed.port = parsed.protocol === "https:" ? "443" : "80";
  }
  return parsed;
}

async function showToast(client: PluginClient, message: string, variant: ToastVariant) {
  await client.tui?.showToast({
    body: {
      message,
      variant,
      duration: 4000,
    },
  });
}

async function runCliCommand(
  $: PluginShell,
  cliCommand: string,
  subcommand: "start" | "stop",
  baseUrl: URL,
) {
  const command = cliCommand.includes("/") ? cliCommand : join(dirname(cliCommand), cliCommand);
  await $`${command} ${subcommand} --host ${baseUrl.hostname} --port ${baseUrl.port}`.quiet();
}

async function openUrl($: PluginShell, url: string) {
  if (process.platform === "darwin") {
    await $`open ${url}`.quiet();
    return;
  }

  if (process.platform === "win32") {
    await $`cmd /c start "" ${url}`.quiet();
    return;
  }

  await $`xdg-open ${url}`.quiet();
}

function neutralizeCommandParts(parts: RewindCommandPart[]) {
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      part.text = "Handled locally by the Rewind plugin. No model response is needed.";
      part.ignored = true;
      part.synthetic = true;
    }
  }
}

export async function rewindPlugin(input: PluginInput, options?: RewindPluginOptions) {
  const { client, $ } = input;
  const config = resolveOptions(options);
  const baseUrl = parseBaseUrl(config.baseUrl);

  return {
    "command.execute.before": async (
      input: CommandExecuteBeforeInput,
      output: CommandExecuteBeforeOutput,
    ) => {
      if (input.command === config.rewindCommand) {
        try {
          neutralizeCommandParts(output.parts);
          await runCliCommand($, config.cliCommand, "start", baseUrl);
          const url = new URL(`/session/${encodeURIComponent(input.sessionID)}`, baseUrl).toString();
          await openUrl($, url);
          await showToast(client, "Opened current session in Rewind", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await showToast(client, `Failed to open Rewind: ${message}`, "error");
        }
        return;
      }

      if (input.command === config.stopCommand) {
        try {
          neutralizeCommandParts(output.parts);
          await runCliCommand($, config.cliCommand, "stop", baseUrl);
          await showToast(client, "Stopped Rewind server", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await showToast(client, `Failed to stop Rewind: ${message}`, "error");
        }
      }
    },
  };
}

export const plugin = rewindPlugin;
export const server = rewindPlugin;

const pluginModule = {
  id: "opencode-rewind",
  server: rewindPlugin,
};

export default pluginModule;
