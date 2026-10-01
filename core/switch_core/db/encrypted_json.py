"""A JSONB column whose whole value is encrypted at rest.

For connection settings — a collaboration bridge's or a server connector's —
which carry platform credentials (bot tokens, app passwords, a server
password) next to ordinary settings. Encrypting the whole value rather than
named fields means a credential field an adapter adds later is covered without
anyone remembering to list it.

The stored shape is ``{"_enc": "<fernet token>"}``; the application only ever
sees the decrypted dict. A value without that shape predates encryption: it is
returned as it is, and `encrypt_legacy_values` rewrites such rows at boot.

The key is process-wide because a column type is: SQLAlchemy builds it once
with the model, long before any configuration exists. `configure` must run
before the first read or write, and either raises if it has not.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Dialect
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import attributes
from sqlalchemy.types import TypeDecorator

from switch_core.crypto import decrypt_token, encrypt_token
from switch_core.db.session_scope import tenant_session

logger = logging.getLogger(__name__)

_ENVELOPE_KEY = "_enc"
_secret: str | None = None


class EncryptionNotConfiguredError(RuntimeError):
    pass


def configure(secret: str) -> None:
    """Set the secret encrypted columns are encrypted with."""
    global _secret
    if not secret:
        raise EncryptionNotConfiguredError("The column encryption secret is empty.")
    _secret = secret


def _require_secret() -> str:
    if _secret is None:
        raise EncryptionNotConfiguredError(
            "An encrypted column was read or written before "
            "switch_core.db.encrypted_json.configure() was called."
        )
    return _secret


def is_encrypted(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == {_ENVELOPE_KEY}


class EncryptedJSONB(TypeDecorator[dict[str, Any]]):
    impl = JSONB
    cache_ok = True

    def __init__(self) -> None:
        # `None` is SQL NULL, not the JSON `null` a plain JSONB column writes:
        # there is nothing to encrypt in an absent config.
        super().__init__(none_as_null=True)

    def process_bind_param(
        self, value: dict[str, Any] | None, dialect: Dialect
    ) -> dict[str, str] | None:
        if value is None:
            return None
        return {_ENVELOPE_KEY: encrypt_token(json.dumps(value), _require_secret())}

    def process_result_value(
        self, value: Any, dialect: Dialect
    ) -> dict[str, Any] | None:
        if value is None:
            return None
        if is_encrypted(value):
            decrypted: dict[str, Any] = json.loads(
                decrypt_token(value[_ENVELOPE_KEY], _require_secret())
            )
            return decrypted
        logger.warning(
            "Read a connection config that is not yet encrypted at rest; it "
            "will be encrypted the next time it is written or at next boot."
        )
        plain: dict[str, Any] = value
        return plain


async def encrypt_legacy_values(
    session: AsyncSession, model: type[Any], column: str
) -> int:
    """Rewrite every row of `model` whose `column` is still plaintext.

    Runs on the caller's session, so under whatever tenant it is bound to —
    the boot fan-out calls it once per tenant. Returns how many rows it
    rewrote; the caller commits.
    """
    table = model.__table__
    rows = await session.execute(
        text(
            f"SELECT id FROM {table.name} "
            f"WHERE jsonb_typeof({column}) = 'object' "
            f"AND NOT jsonb_exists({column}, :key)"
        ),
        {"key": _ENVELOPE_KEY},
    )
    ids = [row[0] for row in rows]
    if not ids:
        return 0
    instances = await session.execute(select(model).where(model.id.in_(ids)))
    for instance in instances.scalars():
        attributes.flag_modified(instance, column)
    await session.flush()
    return len(ids)


async def encrypt_legacy_connection_configs(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_ids: list[str],
    models: list[type[Any]],
) -> None:
    """Encrypt every tenant's plaintext connection configs, once, at boot."""
    total = 0
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            for model in models:
                total += await encrypt_legacy_values(
                    session, model, "connection_config"
                )
            await session.commit()
    if total:
        logger.warning(
            "Encrypted %d connection config(s) that were stored in plaintext.",
            total,
        )
