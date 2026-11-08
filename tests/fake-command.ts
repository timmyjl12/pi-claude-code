import { chmod, writeFile } from "node:fs/promises";

/**
 * Make a fake `claude` script launchable. Windows cannot execute a shebang script, so there it is wrapped in a `.cmd`
 * shim, which also exercises the extension's cmd.exe launch path. Returns the path to configure as the command.
 */
export async function launchable(script: string): Promise<string> {
  await chmod(script, 0o755);
  if (process.platform !== "win32") return script;
  const shim = `${script.replace(/\.m?js$/u, "")}.cmd`;
  await writeFile(shim, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
  return shim;
}
