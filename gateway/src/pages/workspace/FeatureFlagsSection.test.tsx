import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FeatureFlagsSection from "./FeatureFlagsSection";

const LABEL = "Show agent owners on the ecosystem graph";

function serve(canEdit: boolean, serverDefault = false) {
  let choice: boolean | null = null;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") choice = JSON.parse(String(init.body)).enabled;
    if (init?.method === "DELETE") choice = null;
    return new Response(
      JSON.stringify({
        flags: [
          {
            key: "ecosystem.show_owners",
            enabled: choice ?? serverDefault,
            default: serverDefault,
            overridden: choice !== null,
          },
        ],
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

  it("lets an admin go back to the server default", async () => {
    serve(true, true);
    render(<FeatureFlagsSection />);
    const toggle = (await screen.findByRole("switch", { name: LABEL })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText("Following the server default.")).toBeTruthy();
    fireEvent.click(toggle);
    const reset = await screen.findByRole("button", { name: "Use server default" });
    expect(screen.getByText("Set for this workspace. Server default: on.")).toBeTruthy();
    fireEvent.click(reset);
    await waitFor(() =>
      expect((screen.getByRole("switch", { name: LABEL }) as HTMLInputElement).checked).toBe(true),
    );
    expect(screen.queryByRole("button", { name: "Use server default" })).toBeNull();
  });
});
