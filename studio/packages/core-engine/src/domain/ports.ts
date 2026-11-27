import { ulid } from "ulid";

import type { ULID } from "./types";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): ULID;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UlidGenerator implements IdGenerator {
  constructor(private readonly clock: Clock = new SystemClock()) {}

  next(): ULID {
    return ulid(this.clock.now().getTime());
  }
}
