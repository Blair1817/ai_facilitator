const DEFAULT_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 1_000;

function errorMessage(error) {
  if (!error) return "";
  const parts = [error.message, error.cause?.message, error.context?.message]
    .filter((value) => typeof value === "string" && value.length > 0);
  return parts.join(" ");
}

export function isTransientAdminContextError(error) {
  const message = errorMessage(error);
  return message.includes("ECONNREFUSED") || message.includes("connect ECONNRESET");
}

export async function initialiseAdminContextWithRetry(
  initialise,
  {
    attempts = DEFAULT_ATTEMPTS,
    delayMs = DEFAULT_DELAY_MS,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry = () => {},
  } = {},
) {
  if (typeof initialise !== "function") {
    throw new TypeError("initialise must be a function");
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("attempts must be a positive integer");
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await initialise();
    } catch (error) {
      lastError = error;
      if (!isTransientAdminContextError(error) || attempt === attempts) {
        throw error;
      }
      onRetry({ attempt, attempts, delayMs, error });
      await wait(delayMs);
    }
  }

  throw lastError;
}
