import type { Config } from "../config";
import * as agents from "./agents";
import * as blocks from "./blocks";
import * as messages from "./messages";
import { audit as writeAudit, auditLog, countAuthFailures, type StoreContext } from "./audit";
import { cleanup } from "./cleanup";
import * as sessions from "./sessions";

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
  isDisabledAgentKey(rawKey: string) {
    return agents.isDisabledAgentKey(this.ctx, rawKey);
  }
  isActive(name: string) {
    return agents.isActive(this.ctx, name);
  }
  agentState(name: string) {
    return agents.agentState(this.ctx, name);
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
  send(from: string, input: messages.SendInput) {
    return messages.send(this.ctx, from, input);
  }
  inbox(agent: string, limit?: number) {
    return messages.inbox(this.ctx, agent, limit);
  }
  ack(agent: string, ids: string[]) {
    return messages.ack(this.ctx, agent, ids);
  }
  thread(agent: string, threadId: string) {
    return messages.thread(this.ctx, agent, threadId);
  }
  block(agent: string, sender: string) {
    return blocks.block(this.ctx, agent, sender);
  }
  unblock(agent: string, sender: string) {
    return blocks.unblock(this.ctx, agent, sender);
  }
  listBlocked(agent: string) {
    return blocks.listBlocked(this.ctx, agent);
  }
  audit(event: string, actor: string, target: string | null, subject?: string | null, body?: string | null) {
    return writeAudit(this.ctx, event, actor, target, subject, body);
  }
  /** auth_failed rows for `actor` within the last `windowMs`. */
  recentAuthFailures(actor: string, windowMs: number) {
    return countAuthFailures(this.ctx, actor, this.ctx.now() - windowMs);
  }
  auditLog(q: { since?: number; agent?: string; limit?: number }) {
    return auditLog(this.ctx, q);
  }
  bindSession(id: string, principal: string) {
    return sessions.bindSession(this.ctx, id, principal);
  }
  sessionPrincipal(id: string) {
    return sessions.sessionPrincipal(this.ctx, id);
  }
  cleanup(batch?: number) {
    return cleanup(this.ctx, batch);
  }
}
