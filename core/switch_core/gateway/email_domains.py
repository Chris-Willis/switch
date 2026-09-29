"""The domain of an e-mail address, and the domains no workspace may claim.

A workspace can let anyone at a domain join it without an invitation. That is
only meaningful for a domain one organisation controls: opening a workspace to
a public e-mail provider's domain would open it to anyone who signs up there.
The list below is the providers common enough that an admin is likely to hold
an address at one; it is a guard against the obvious mistake, not a registry
of every free-mail service there is.
"""

from __future__ import annotations

PUBLIC_EMAIL_DOMAINS = frozenset(
    {
        "163.com",
        "aol.com",
        "fastmail.com",
        "gmail.com",
        "gmx.com",
        "gmx.de",
        "gmx.net",
        "googlemail.com",
        "hey.com",
        "hotmail.com",
        "icloud.com",
        "live.com",
        "mail.com",
        "mail.ru",
        "me.com",
        "msn.com",
        "outlook.com",
        "pm.me",
        "proton.me",
        "protonmail.com",
        "qq.com",
        "tutanota.com",
        "web.de",
        "yahoo.com",
        "yandex.com",
        "yandex.ru",
        "zoho.com",
    }
)


def email_domain(email: str) -> str:
    """The lower-cased part of `email` after its last `@`.

    Raises `ValueError` for a string with no domain, which an account address
    should never be — so a caller reaching it has a malformed account, and
    guessing a domain for it would be worse than saying so.
    """
    _, at, domain = email.rpartition("@")
    domain = domain.strip().lower()
    if not at or not domain:
        raise ValueError(f"{email!r} has no domain")
    return domain


def join_domain_refusal(domain: str) -> str | None:
    """Why a workspace may not be opened to `domain`, or None if it may."""
    if domain in PUBLIC_EMAIL_DOMAINS:
        return (
            f"{domain} is a public e-mail provider, so opening the workspace "
            "to it would let anyone with an address there join"
        )
    return None
