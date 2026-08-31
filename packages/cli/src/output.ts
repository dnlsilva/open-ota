/** Terminal output, exit codes and the one error type commands are allowed to throw. */

import { InvalidArgumentError } from "commander";
import { bold, cyan, dim, green, red, yellow } from "kleur/colors";
import { OtaApiError } from "@open-ota/shared";

/** An expected failure: printed as a message, never as a stack trace. Exit 1. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "UserError";
  }
}

export function fail(message: string, hint?: string): never {
  throw new UserError(message, hint);
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function step(message: string): void {
  process.stderr.write(`${cyan("›")} ${message}\n`);
}

export function ok(message: string): void {
  process.stderr.write(`${green("✔")} ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${yellow("!")} ${message}\n`);
}

export function note(message: string): void {
  process.stderr.write(`${dim(message)}\n`);
}

/** Machine-readable output always goes to stdout, human chatter to stderr. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

export interface Column {
  header: string;
  align?: "left" | "right";
}

/**
 * Plain-text table: cells must not contain ANSI codes, or the column widths go
 * wrong. Colour is applied to whole lines afterwards by `printTable`.
 */
export function formatTable(columns: Column[], rows: string[][]): string {
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    columns
      .map((column, i) => {
        const cell = cells[i] ?? "";
        const width = widths[i] ?? 0;
        return column.align === "right" ? cell.padStart(width) : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd();

  return [line(columns.map((column) => column.header)), ...rows.map(line)].join("\n");
}

export function printTable(columns: Column[], rows: string[][]): void {
  const [header = "", ...body] = formatTable(columns, rows).split("\n");
  print(bold(header));
  for (const row of body) print(row);
}

/** Bad flag values are a usage error (exit 2), not a runtime failure. */
export function parsePercent(value: string): number {
  const percent = Number(value);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new InvalidArgumentError("expected a whole number between 0 and 100");
  }
  return percent;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`;
}

/** Turns any thrown value into a printed message and the exit code to use. */
export function reportError(error: unknown): number {
  if (error instanceof UserError) {
    process.stderr.write(`${red("✘")} ${error.message}\n`);
    if (error.hint) process.stderr.write(`${dim(error.hint)}\n`);
    return EXIT_FAILURE;
  }

  if (error instanceof OtaApiError) {
    process.stderr.write(`${red("✘")} ${apiErrorMessage(error)}\n`);
    if (error.status === 401) process.stderr.write(`${dim("Run `ota login` to re-authenticate.")}\n`);
    return EXIT_FAILURE;
  }

  const networkCode = networkErrorCode(error);
  if (networkCode) {
    process.stderr.write(`${red("✘")} Could not reach the Open OTA API (${networkCode}).\n`);
    process.stderr.write(`${dim("Check the api url in ota.config.json or OTA_API_URL, and your network.")}\n`);
    return EXIT_FAILURE;
  }

  process.stderr.write(`${red("✘")} Unexpected error\n`);
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  return EXIT_FAILURE;
}

function apiErrorMessage(error: OtaApiError): string {
  if (error.status === 401) return "Not authorized — your token is missing, expired or revoked.";
  if (error.status === 403) return `Forbidden — the token lacks permission. ${error.message}`;
  return `${error.message} (${error.code})`;
}

function networkErrorCode(error: unknown): string | null {
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  const code = cause?.code;
  if (!code) return null;
  return ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "CERT_HAS_EXPIRED"].includes(code)
    ? code
    : null;
}
