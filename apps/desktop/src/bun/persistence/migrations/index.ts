import { id as m001, up as up001 } from "./001_create_provider_pins.js";

export interface Migration {
  id: string;
  up: (db: import("bun:sqlite").Database) => void;
}

export const migrations: Migration[] = [{ id: m001, up: up001 }];
