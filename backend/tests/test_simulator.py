import time

import pytest

from aura.simulator import DeviceError, DeviceUnreachable


def commands(services, device_id):
    return services.db.query("SELECT * FROM device_commands WHERE device_id = ?", (device_id,))


def test_ack_is_not_state_change_until_settled(services):
    sim = services.sim
    ack = sim.set_state("porch_light", {"power": "on"}, "k1")
    assert ack["accepted"] is True
    assert sim.read_state("porch_light")["state"]["power"] == "off"  # not applied yet
    time.sleep(0.08)
    assert sim.read_state("porch_light")["state"]["power"] == "on"


def test_energy_saver_hold_acks_but_ignores_setpoint(services):
    sim = services.sim
    sim.inject_fault("thermostat", "energy_saver_hold")
    ack = sim.set_state("thermostat", {"setpoint_f": 72}, "k-hold")
    assert ack["accepted"] is True and ack["status"] == "ACCEPTED"
    time.sleep(0.08)
    state = sim.read_state("thermostat")["state"]
    assert state["setpoint_f"] == 76
    assert state["hold"] == "energy_saver"


def test_releasing_hold_with_setpoint_applies(services):
    sim = services.sim
    sim.inject_fault("thermostat", "energy_saver_hold")
    sim.set_state("thermostat", {"hold": "none", "setpoint_f": 72}, "k-release")
    time.sleep(0.08)
    state = sim.read_state("thermostat")["state"]
    assert state == {**state, "setpoint_f": 72, "hold": "none"}


def test_idempotency_key_prevents_double_apply(services):
    sim = services.sim
    first = sim.set_state("living_room_lights", {"power": "off"}, "same-key")
    second = sim.set_state("living_room_lights", {"power": "on"}, "same-key")
    assert second["duplicate"] is True
    assert second["command_id"] == first["command_id"]
    assert len(commands(services, "living_room_lights")) == 1
    time.sleep(0.08)
    assert sim.read_state("living_room_lights")["state"]["power"] == "off"


@pytest.mark.parametrize(
    "device,attrs",
    [("thermostat", {"setpoint_f": 95}), ("thermostat", {"color": "red"}), ("front_door", {"locked": "yes"}),
     ("living_room_lights", {"brightness": 101}), ("nope", {"power": "on"})],
)
def test_invalid_commands_are_rejected(services, device, attrs):
    with pytest.raises(DeviceError):
        services.sim.set_state(device, attrs, f"bad-{device}-{list(attrs)[0]}")


def test_unreachable_device_cannot_be_read_and_command_is_lost(services):
    sim = services.sim
    sim.inject_fault("front_door", "unreachable")
    ack = sim.set_state("front_door", {"locked": True}, "k-offline")
    assert ack["accepted"] is True
    with pytest.raises(DeviceUnreachable):
        sim.read_state("front_door")
    sim.clear_faults("front_door")
    time.sleep(0.08)
    assert sim.read_state("front_door")["state"]["locked"] is False


def test_drop_next_command_drops_exactly_one(services):
    sim = services.sim
    sim.inject_fault("porch_light", "drop_next_command")
    sim.set_state("porch_light", {"power": "on"}, "d1")
    time.sleep(0.08)
    assert sim.read_state("porch_light")["state"]["power"] == "off"
    sim.set_state("porch_light", {"power": "on"}, "d2")
    time.sleep(0.08)
    assert sim.read_state("porch_light")["state"]["power"] == "on"


def test_state_persists_across_instances(services, settings):
    from aura.services import HouseholdServices

    services.sim.set_state("white_noise", {"power": "on"}, "persist")
    time.sleep(0.08)
    services.sim.read_state("white_noise")
    fresh = HouseholdServices(settings)
    assert fresh.sim.read_state("white_noise")["state"]["power"] == "on"
