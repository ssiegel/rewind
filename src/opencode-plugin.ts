type ToastVariant = "info" | "success" | "warning" | "error";

type CommandExecutedEvent = {
  type: "command.executed";
  properties: {
    name: string;
    sessionID: string;
  };
};

type PluginEvent = CommandExecutedEvent | { type: string; properties?: Record<string, unknown> };

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
const DEFAULT_CLI_COMMAND = "opencode-rewind";

function isCommandExecutedEvent(event: PluginEvent): event is CommandExecutedEvent {
  return event.type === "command.executed";
}

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
  await $`${cliCommand} ${subcommand} --host ${baseUrl.hostname} --port ${baseUrl.port}`.quiet();
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

export async function rewindPlugin(input: PluginInput, options?: RewindPluginOptions) {
  const { client, $ } = input;
  const config = resolveOptions(options);
  const baseUrl = parseBaseUrl(config.baseUrl);

  return {
    event: async ({ event }: { event: PluginEvent }) => {
      if (!isCommandExecutedEvent(event)) return;

      if (event.properties.name === config.rewindCommand) {
        try {
          await runCliCommand($, config.cliCommand, "start", baseUrl);
          const url = new URL(`/session/${encodeURIComponent(event.properties.sessionID)}`, baseUrl).toString();
          await openUrl($, url);
          await showToast(client, "Opened current session in Rewind", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await showToast(client, `Failed to open Rewind: ${message}`, "error");
        }
        return;
      }

      if (event.properties.name === config.stopCommand) {
        try {
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
