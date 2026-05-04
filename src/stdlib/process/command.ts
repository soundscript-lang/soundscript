import { Child, output, spawn } from 'sts:process';

export type { CommandOptions, CommandOutput, CommandStatus } from 'sts:process';
export { Child, output, spawn };

export const Command = Object.freeze({
  Child,
  spawn,
  output,
});
