"""The ticket that carries a redeemed grant from the callback to the decision.

An install is not claimed when the platform redirects back. The person who
approved it on the platform may not be the person who started it — a link to a
platform's consent screen can be sent to anyone — so the callback shows them
which Switch organisation the workspace would join, and only an explicit
Connect on that page claims it.

Between the two requests the grant has to live somewhere. It travels in the
page itself, as this ticket, rather than in the database: an approver who
closes the tab leaves nothing behind here, and no bot token is stored for an
install nobody agreed to.

The ticket is encrypted, not just signed, because it carries the bot token. It
is also the proof that whoever submits the decision saw the page: the state
token alone is not, since whoever started the install holds it. The key is
derived from `JWT_SECRET_KEY` under its own label, so a ticket is never
mistakable for any other ciphertext made from the same secret.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import timedelta

from cryptography.fernet import Fernet, InvalidToken

from switch_core.bridges.collaboration.install import InstallGrant

_KEY_INFO = b"switch/messaging-install-confirm/v1"

#: How long the approver has to choose on the confirmation page.
CONFIRM_TTL = timedelta(minutes=15)


class InstallTicketError(RuntimeError):
    """A ticket was malformed, not ours, or older than `CONFIRM_TTL`."""


@dataclass(frozen=True)
class InstallTicket:
    tenant_id: str
    state_id: str
    platform: str
    grant: InstallGrant


def _fernet(secret: str) -> Fernet:
    key = hmac.new(secret.encode(), _KEY_INFO, hashlib.sha256).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def seal(ticket: InstallTicket, *, secret: str) -> str:
    payload = json.dumps(
        {
            "tid": ticket.tenant_id,
            "sid": ticket.state_id,
            "plat": ticket.platform,
            "ws": ticket.grant.external_workspace_id,
            "name": ticket.grant.workspace_name,
            "tok": ticket.grant.bot_token,
            "scopes": ticket.grant.scopes,
        },
        separators=(",", ":"),
    )
    return _fernet(secret).encrypt(payload.encode()).decode()


def open_ticket(token: str, *, secret: str) -> InstallTicket:
    try:
        raw = _fernet(secret).decrypt(
            token.encode(), ttl=int(CONFIRM_TTL.total_seconds())
        )
    except InvalidToken:
        raise InstallTicketError(
            "install confirmation is not one this deployment issued, or has expired"
        ) from None
    decoded = json.loads(raw)
    return InstallTicket(
        tenant_id=decoded["tid"],
        state_id=decoded["sid"],
        platform=decoded["plat"],
        grant=InstallGrant(
            external_workspace_id=decoded["ws"],
            workspace_name=decoded["name"],
            bot_token=decoded["tok"],
            scopes=decoded["scopes"],
        ),
    )
