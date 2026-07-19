import type {
  PublishingConfigUpdate,
  PublishingConfigView,
  PublishingStatus,
} from "../../shared/publishing.js";

export type { PublishingConfigUpdate, PublishingConfigView, PublishingStatus };

/** Full persisted publishing configuration including secrets. */
export interface PublishingConfig {
  projectPath: string;

  // Server / Hetzner
  serverIp?: string;
  sshKeyPath?: string;
  sshPublicKey?: string;

  // Coolify connection
  coolifyUrl?: string;
  coolifyApiToken?: string;

  // Coolify resources (populated by the agent after deployment)
  coolifyProjectId?: string;
  coolifyProjectName?: string;
  coolifyApplicationId?: string;

  // Domain
  domain?: string;

  // Pipeline status
  status: PublishingStatus;

  createdAt: number;
  updatedAt: number;
}
