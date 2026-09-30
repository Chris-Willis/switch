from pathlib import Path

from botocore.stub import Stubber
from test_controller import config, ec2_client, store_and_machine, volume

from switch_hosted_controller.cloud import Ec2Cloud
from switch_hosted_controller.model import DesiredState, ObservedState
from switch_hosted_controller.reconciler import Reconciler


def test_create_volume_error_is_recovered_by_tag_discovery(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    filters = cloud._resource_filters(machine, "data")

    with Stubber(client) as stubber:
        stubber.add_response("describe_volumes", {"Volumes": []}, {"Filters": filters})
        stubber.add_client_error("create_volume", service_error_code="RequestTimeout")
        Reconciler(store, cloud).reconcile_all()

    uncertain = store.get(machine.machine_id)
    assert uncertain.volume_create_intent
    assert uncertain.volume_create_issued
    assert uncertain.observed_state is ObservedState.NEEDS_ATTENTION

    owned_volume = volume(cfg, uncertain)
    with Stubber(client) as stubber:
        stubber.add_response("describe_volumes", {"Volumes": [owned_volume]}, {"Filters": filters})
        recovered = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert recovered.data_volume_id == owned_volume["VolumeId"]
    store.close()


def test_stop_cancels_queued_launch_before_any_api_write(tmp_path: Path):
    cfg = config(tmp_path)
    store, machine = store_and_machine(cfg)
    store.mark_instance_launch_intent(machine)
    store.set_desired(machine.machine_id, DesiredState.STOPPED, None)

    client = ec2_client()
    cloud = Ec2Cloud(client, cfg)
    with Stubber(client) as stubber:
        stubber.add_response(
            "describe_instances",
            {"Reservations": []},
            {"Filters": cloud._resource_filters(machine, "worker")},
        )
        stopped = Reconciler(store, cloud).reconcile(machine.machine_id)
    assert stopped.observed_state is ObservedState.STOPPED
    assert not stopped.instance_launch_intent
    assert not stopped.instance_launch_issued
    store.close()
