import {
  Alert,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useCallback, useState } from "react";
import { type FeatureFlagsResponse, fetchFeatureFlags, setFeatureFlag } from "../../data/api";
import { useLoad } from "./useLoad";

/** What each flag turns on, for the people deciding. A flag the server knows
 * and this list does not is still shown, by its key. */
const FLAG_LABELS: Record<string, { label: string; help: string }> = {
  "ecosystem.show_owners": {
    label: "Show agent owners on the ecosystem graph",
    help: "Lets anyone in the workspace see who owns each agent on the ecosystem page.",
  },
};

/** The workspace's feature flags. Everyone sees them; owners and admins can
 * change them, and the server refuses anyone else. */
export default function FeatureFlagsSection() {
  const load = useCallback(() => fetchFeatureFlags(), []);
  const { data, error, loading } = useLoad<FeatureFlagsResponse>(load);
  const [current, setCurrent] = useState<FeatureFlagsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const shown = current ?? data;

  const flip = async (key: string, enabled: boolean) => {
    setBusy(key);
    setActionError(null);
    try {
      setCurrent(await setFeatureFlag(key, enabled));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "The change failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Feature flags</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {actionError && (
        <Alert severity="error" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : (
        shown && (
          <Stack spacing={1}>
            {shown.flags.map((flag) => {
              const meta = FLAG_LABELS[flag.key];
              return (
                <Stack key={flag.key} spacing={0}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={flag.enabled}
                        disabled={!shown.can_edit || busy !== null}
                        onChange={(e) => void flip(flag.key, e.target.checked)}
                      />
                    }
                    label={meta?.label ?? flag.key}
                  />
                  {meta && (
                    <Typography variant="body2" sx={{ color: "text.secondary", ml: 6 }}>
                      {meta.help}
                    </Typography>
                  )}
                </Stack>
              );
            })}
            {!shown.can_edit && (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                Only workspace owners and admins can change these.
              </Typography>
            )}
          </Stack>
        )
      )}
    </Stack>
  );
}
