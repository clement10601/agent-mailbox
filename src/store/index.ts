import type { Config } from "../config";
import * as agents from "./agents";
import { audit as writeAudit, type StoreContext } from "./audit";

export class Store {
  private ctx: StoreContext;

  constructor(db: D1Database, config: Config, now: () => number = Date.now) {
    this.ctx = { db, config, now };
  }

  createAgent(name: string, description: string) {
    return agents.createAgent(this.ctx, name, description);
  }
  issueKey(name: string) {
    return agents.issueKey(this.ctx, name);
  }
  revokeKey(keyId: string) {
    return agents.revokeKey(this.ctx, keyId);
  }
  setDisabled(name: string, disabled: boolean) {
    return agents.setDisabled(this.ctx, name, disabled);
  }
  resolveKey(rawKey: string) {
    return agents.resolveKey(this.ctx, rawKey);
  }
  isActive(name: string) {
    return agents.isActive(this.ctx, name);
  }
  touch(name: string) {
    return agents.touch(this.ctx, name);
  }
  listAgents() {
    return agents.listAgents(this.ctx);
  }
  adminListAgents() {
    return agents.adminListAgents(this.ctx);
  }
  getProfile(name: string) {
    return agents.getProfile(this.ctx, name);
  }
  updateProfile(name: string, description: string) {
    return agents.updateProfile(this.ctx, name, description);
  }
  audit(event: string, actor: string, target: string | null, subject?: string | null, body?: string | null) {
    return writeAudit(this.ctx, event, actor, target, subject, body);
  }
}
