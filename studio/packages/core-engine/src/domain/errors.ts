export const ERROR_EXIT_CODES = {
  E_USAGE: 2,
  E_REVISION_CONFLICT: 4,
  E_NOT_FOUND: 3,
  E_PROJECT_NOT_FOUND: 3,
  E_PROJECT_REQUIRED: 3,
  E_LAYER_NOT_FOUND: 3,
  E_ASSET_NOT_FOUND: 3,
  E_SPACE_NOT_FOUND: 3,
  E_SPACE_DELETED: 3,
  E_NO_ACTIVE_VIEW: 3,
  E_LIVE_UNAVAILABLE: 6,
  E_URL_BLOCKED: 3,
  E_NO_DRAFT: 4,
  E_DRAFT_EXPIRED: 4,
  E_DRAFT_CONSUMED: 4,
  E_PATCH_INVALID: 4,
  E_REDO_INVALID: 4,
  E_HASH_MISMATCH: 4,
  E_AUTH: 5,
  E_CONNECT: 6,
  E_INTERNAL: 1,
  E_WATCH_TIMEOUT: 124,
} as const;

export type HumanBoardErrorCode = keyof typeof ERROR_EXIT_CODES;

export type HumanBoardErrorDetails = Readonly<Record<string, unknown>>;

export class HumanBoardError extends Error {
  readonly code: HumanBoardErrorCode;
  readonly exitCode: number;
  readonly details: HumanBoardErrorDetails;

  constructor(
    code: HumanBoardErrorCode,
    message: string,
    details: HumanBoardErrorDetails = {},
  ) {
    super(message);
    this.name = "HumanBoardError";
    this.code = code;
    this.exitCode = ERROR_EXIT_CODES[code];
    this.details = Object.freeze({ ...details });
  }

  toJSON(): {
    error: {
      code: HumanBoardErrorCode;
      message: string;
      details: HumanBoardErrorDetails;
    };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}
