import type { WorkspaceRole } from './workspaces';

/** An invitation to a workspace, as the gateway lists it to the workspace's admins. */
export type Invitation = {
  id: string;
  role: WorkspaceRole;
  /** The one address that may accept it, or null for anyone holding the link. */
  email: string | null;
  /** ISO 8601. */
  expiresAt: string;
  usesRemaining: number;
  /** ISO 8601, or null while it has not been revoked. */
  revokedAt: string | null;
  createdAt: string;
};

/**
 * What became of the e-mail an invitation asked for.
 *
 * `not_requested` is an invitation that named no address; `not_configured` a
 * server with no mail relay; `failed` a relay that refused or could not be
 * reached. The invitation stands in every case, and its link is the way in.
 */
export type InvitationEmailDelivery = 'sent' | 'not_configured' | 'failed' | 'not_requested';

export type CreateInvitationParams = {
  workspaceId: string;
  role: WorkspaceRole;
  email: string | null;
  expiresInHours: number;
  usesRemaining: number;
};

/**
 * A new invitation and the link to it.
 *
 * The link is only ever available here: the server keeps a hash of the token,
 * so once this is dismissed nobody can show it again.
 */
export type CreatedInvitation = {
  invitation: Invitation;
  link: string;
  emailDelivery: InvitationEmailDelivery;
};

/** A workspace's invitations, and whether an addressed one is e-mailed. */
export type WorkspaceInvitations = {
  invitations: Invitation[];
  emailEnabled: boolean;
};

export type InvitationStatus = 'active' | 'revoked' | 'expired' | 'used';

/** Whether an invitation can still be accepted, and if not, why not. */
export function invitationStatus(invitation: Invitation, now: number): InvitationStatus {
  if (invitation.revokedAt !== null) return 'revoked';
  if (new Date(invitation.expiresAt).getTime() <= now) return 'expired';
  if (invitation.usesRemaining <= 0) return 'used';
  return 'active';
}

/**
 * The link an invitee opens or pastes into Switch Console.
 *
 * Built from the gateway's own address, as the server's dashboard builds it
 * from the page it is served on: both are the origin that answers `/gateway`.
 * The token rides in the fragment, which a browser never sends, so it stays out
 * of proxy and access logs.
 */
export function inviteLink(gatewayUrl: string, token: string): string {
  return `${gatewayUrl.replace(/\/+$/, '')}/invite#token=${encodeURIComponent(token)}`;
}
