import { create } from "zustand";

import type { Session } from "../../../../shared/rpc.js";
import type { AppSession } from "./types.js";

export const useAppStore = create<
  AppSession & {
    setSession: (session?: Session) => void;
  }
>((set) => ({
  setSession: (session) => set({ session }),
}));
