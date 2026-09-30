import json
from pathlib import Path

import pytest

from switch_hosted_controller import cli
from switch_hosted_controller.config import ControllerConfig
from switch_hosted_controller.model import ObservedState
from switch_hosted_controller.store import MachineStore

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def config_path(tmp_path: Path) -> Path:
    raw = json.loads((FIXTURES / "controller.json").read_text())
    raw["state_db_path"] = str(tmp_path / "state.db")
    raw["lock_path"] = str(tmp_path / "controller.lock")
    path = tmp_path / "controller.json"
    path.write_text(json.dumps(raw))
    return path


def run(capsys, config_path: Path, *argv: str) -> tuple[int, dict | list | None]:
    code = cli.main(["--config", str(config_path), *argv])
    captured = capsys.readouterr()
    output = captured.out if code == 0 else captured.err
    return code, json.loads(output) if output.strip() else None


def observe(config_path: Path, machine_id: str, observed: ObservedState) -> None:
    config = ControllerConfig.load(config_path)
    store = MachineStore(config.state_db_path, config.fingerprint())
    try:
        store.set_observed(store.get(machine_id), observed, None)
    finally:
        store.close()


def test_create_status_and_delete_are_keyed_by_slot(capsys, config_path):
    code, created = run(capsys, config_path, "create", "slot-a", "--instance-type", "m6i.large")
    assert code == 0
    assert created["slot_id"] == "slot-a"
    assert created["generation"] == 1
    assert created["desired_state"] == "running"
    assert created["retain_until"] is None
    assert set(created) == {
        "machine_id",
        "slot_id",
        "generation",
        "instance_type",
        "desired_state",
        "desired_revision",
        "observed_state",
        "instance_id",
        "instance_seq",
        "data_volume_id",
        "retain_until",
        "error",
    }
    assert run(capsys, config_path, "status", "slot-a")[1] == created

    code, error = run(
        capsys, config_path, "delete", "slot-a", "--confirm-slot-id", "slot-b", "--retain-volume"
    )
    assert code == 2
    assert "confirm-slot-id" in error["error"]

    code, retained = run(
        capsys, config_path, "delete", "slot-a", "--confirm-slot-id", "slot-a", "--retain-volume"
    )
    assert code == 0
    assert retained["desired_state"] == "retained"
    observe(config_path, created["machine_id"], ObservedState.RETAINED)
    code, deleted = run(
        capsys, config_path, "delete", "slot-a", "--confirm-slot-id", "slot-a", "--delete-volume"
    )
    assert code == 0
    assert deleted["desired_state"] == "deleted"

    code, error = run(capsys, config_path, "create", "slot-a", "--instance-type", "m6i.large")
    assert code == 2
    observe(config_path, created["machine_id"], ObservedState.DELETED)
    code, reused = run(capsys, config_path, "create", "slot-a", "--instance-type", "m6i.large")
    assert code == 0
    assert reused["generation"] == 2
    assert reused["machine_id"] != created["machine_id"]
    assert run(capsys, config_path, "status", "slot-a")[1] == reused
    code, listed = run(capsys, config_path, "list")
    assert [(item["slot_id"], item["generation"]) for item in listed] == [
        ("slot-a", 1),
        ("slot-a", 2),
    ]


@pytest.mark.parametrize(
    "argv",
    [
        ("create", "slot-a", "--instance-type", "m6i.xlarge"),
        ("create", "slot-z", "--instance-type", "m6i.large"),
        ("status", "slot-a"),
    ],
)
def test_invalid_requests_exit_2(capsys, config_path, argv):
    code, error = run(capsys, config_path, *argv)
    assert code == 2
    assert error["error"]
