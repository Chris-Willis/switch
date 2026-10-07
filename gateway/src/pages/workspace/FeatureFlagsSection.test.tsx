import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FeatureFlagsSection from "./FeatureFlagsSection";

const LABEL = "Show agent owners on the ecosystem graph";

function serve(canEdit: boolean) {
  let enabled = false;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") enabled = JSON.parse(String(init.body)).enabled;
    return new Response(
      JSON.stringify({
        flags: [{ key: "ecosystem.show_owners", enabled }],
        can_edit: canEdit,
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("FeatureFlagsSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lets an admin flip a flag", async () => {
    const fetchMock = serve(true);
    render(<FeatureFlagsSection />);
    const toggle = (await screen.findByRole("switch", { name: LABEL })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect((screen.getByRole("switch", { name: LABEL }) as HTMLInputElement).checked).toBe(true),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put?.[0]).toContain("/feature-flags/ecosystem.show_owners");
  });

  it("shows a member the flags without letting them change any", async () => {
    serve(false);
    render(<FeatureFlagsSection />);
    const toggle = (await screen.findByRole("switch", { name: LABEL })) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText("Only workspace owners and admins can change these.")).toBeTruthy();
  });
});
