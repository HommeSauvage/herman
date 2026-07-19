import { id as m001, up as up001 } from "./001_create_provider_pins.js";
import { id as m002, up as up002 } from "./002_create_publishing_config.js";

export interface Migration {
  id: string;
  up: (db: import("bun:sqlite").Database) => void;
}

export const migrations: Migration[] = [
  { id: m001, up: up001 },
  { id: m002, up: up002 },
];
