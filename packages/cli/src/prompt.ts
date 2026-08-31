import prompts, { type Answers, type PromptObject } from "prompts";

import { UserError } from "./output.js";

/** Prompts that abort cleanly on Ctrl+C and refuse to hang a CI job. */
export async function ask<T extends string>(
  questions: PromptObject<T> | Array<PromptObject<T>>,
): Promise<Answers<T>> {
  if (!process.stdin.isTTY) {
    throw new UserError(
      "This command needs an interactive terminal.",
      "Pass the values as flags instead (see `--help`).",
    );
  }
  return prompts(questions, {
    onCancel: () => {
      throw new UserError("Cancelled.");
    },
  });
}

export async function confirm(message: string, initial = false): Promise<boolean> {
  const { value } = await ask<"value">({ type: "confirm", name: "value", message, initial });
  return Boolean(value);
}
