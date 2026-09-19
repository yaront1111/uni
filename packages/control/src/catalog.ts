import type { ActionKind } from '@unai/domain';

/**
 * Uai's own plugin capabilities (PRD §27.1; ADR 0027 §2).
 *
 * One entry per discrete capability, each with its own risk class, exactly as
 * the connector manifests do for reads. A DRAFT capability produces a Uai
 * artifact and writes nothing outside Uai; a WRITE capability would, and V0
 * lists it so the Permissions screen can say "refused" rather than pretend it
 * does not exist. `plugin_capability_grants` refuses a granted WRITE row.
 */
export interface PluginCapability {
  readonly capabilityId: string;
  readonly description: string;
  readonly access: 'DRAFT' | 'WRITE';
  readonly riskClass: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly actionKind: ActionKind;
}

export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = Object.freeze([
  { capabilityId: 'gmail.create_draft', access: 'DRAFT', riskClass: 'MEDIUM', actionKind: 'DRAFT',
    description: 'Prepare an email draft inside Uai for you to review. Nothing is sent or saved to Gmail.' },
  { capabilityId: 'calendar.create_draft', access: 'DRAFT', riskClass: 'MEDIUM', actionKind: 'DRAFT',
    description: 'Prepare a calendar event draft inside Uai for you to review. Nothing is written to your calendar.' },
  { capabilityId: 'gmail.send', access: 'WRITE', riskClass: 'HIGH', actionKind: 'EMAIL_SEND',
    description: 'Send email on your behalf. Refused in V0.' },
  { capabilityId: 'calendar.create', access: 'WRITE', riskClass: 'HIGH', actionKind: 'CALENDAR_CREATE',
    description: 'Create calendar events. Refused in V0.' },
  { capabilityId: 'calendar.update', access: 'WRITE', riskClass: 'HIGH', actionKind: 'CALENDAR_UPDATE',
    description: 'Change calendar events. Refused in V0.' },
  { capabilityId: 'finance.move_money', access: 'WRITE', riskClass: 'HIGH', actionKind: 'MONEY_MOVEMENT',
    description: 'Move money between accounts or pay someone. Refused in V0.' },
  { capabilityId: 'trading.submit_order', access: 'WRITE', riskClass: 'HIGH', actionKind: 'TRADE',
    description: 'Submit a trade order to a broker. Refused in V0.' },
]);

export function pluginCapabilityOf(capabilityId: string): PluginCapability | undefined {
  return PLUGIN_CAPABILITIES.find(entry => entry.capabilityId === capabilityId);
}

/** The capability an external action kind would need, for the refusal to name. */
export function capabilityForAction(actionKind: ActionKind): PluginCapability | undefined {
  return PLUGIN_CAPABILITIES.find(entry => entry.access === 'WRITE' && entry.actionKind === actionKind);
}
