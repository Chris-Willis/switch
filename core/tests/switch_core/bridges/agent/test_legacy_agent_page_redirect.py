"""Old `/agents[/<id>]` gateway page links reach the agent API on a shared
origin; a browser page load is redirected to the agent directory, and every
other request passes through untouched."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient

from switch_core.bridges.agent.app import LegacyAgentPageRedirectMiddleware

BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"


def _client() -> TestClient:
    app = FastAPI()

    @app.api_route("/{path:path}", methods=["GET", "HEAD", "POST"])
    async def _downstream(path: str) -> PlainTextResponse:
        return PlainTextResponse("downstream", status_code=401)

    app.add_middleware(LegacyAgentPageRedirectMiddleware)
    return TestClient(app, follow_redirects=False)


def test_browser_load_of_agent_list_redirects() -> None:
    response = _client().get("/agents", headers={"Accept": BROWSER_ACCEPT})
    assert response.status_code == 302
    assert response.headers["location"] == "/agent-directory"


def test_browser_load_of_agent_detail_redirects() -> None:
    response = _client().get("/agents/agent-1/", headers={"Accept": BROWSER_ACCEPT})
    assert response.status_code == 302
    assert response.headers["location"] == "/agent-directory/agent-1"


def test_agent_id_is_reencoded() -> None:
    response = _client().get("/agents/a%20b", headers={"Accept": BROWSER_ACCEPT})
    assert response.headers["location"] == "/agent-directory/a%20b"


def test_request_with_authorization_passes_through() -> None:
    response = _client().get(
        "/agents/agent-1",
        headers={"Accept": BROWSER_ACCEPT, "Authorization": "Bearer t"},
    )
    assert response.text == "downstream"


def test_api_client_without_html_accept_passes_through() -> None:
    response = _client().get("/agents/agent-1", headers={"Accept": "application/json"})
    assert response.text == "downstream"


def test_deeper_agent_api_path_passes_through() -> None:
    response = _client().get(
        "/agents/agent-1/events", headers={"Accept": BROWSER_ACCEPT}
    )
    assert response.text == "downstream"


def test_post_passes_through() -> None:
    response = _client().post("/agents", headers={"Accept": BROWSER_ACCEPT})
    assert response.text == "downstream"
