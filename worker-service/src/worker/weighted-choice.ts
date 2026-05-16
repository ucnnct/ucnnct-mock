export function pickWeighted<TAction extends string>(
  choices: Array<{ action: TAction; weight: number }>
): TAction {
  const total = choices.reduce((sum, choice) => sum + Math.max(0, choice.weight), 0);
  if (total <= 0) {
    return choices[0]!.action;
  }

  let cursor = Math.random() * total;
  for (const choice of choices) {
    cursor -= Math.max(0, choice.weight);
    if (cursor <= 0) {
      return choice.action;
    }
  }

  return choices[choices.length - 1]!.action;
}

export function randomInt(min: number, max: number): number {
  if (max <= min) {
    return Math.round(min);
  }
  const lower = Math.ceil(min);
  const upper = Math.floor(max);
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}
