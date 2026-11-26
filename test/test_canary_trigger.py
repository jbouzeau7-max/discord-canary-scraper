"""Offline dispatch and restart checks for the standalone Canary trigger."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import canary_trigger as trigger


class CanaryTriggerTests(unittest.TestCase):
    def test_stale_edge_does_not_rewind_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(trigger, 'STATE', Path(tmp) / 'last'), patch.object(trigger, 'get_canary_build', side_effect=[('120', None), ('119', None), ('120', None), ('121', None)]), patch.object(trigger, 'dispatch_github_actions', return_value=(True, 'ok')) as dispatch:
            for _ in range(4):
                trigger.tick()
            self.assertEqual([c.kwargs['client_payload']['build'] for c in dispatch.call_args_list], ['120', '121'])
            self.assertEqual(trigger.read_state(trigger.STATE), '121')

    def test_failed_dispatch_is_retried_after_restart(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(trigger, 'STATE', Path(tmp) / 'last'), patch.object(trigger, 'get_canary_build', return_value=('121', None)), patch.object(trigger, 'dispatch_github_actions', side_effect=[(False, 'unavailable'), (True, 'ok')]) as dispatch:
            trigger.write_state(trigger.STATE, '120')
            trigger.tick()
            self.assertEqual(trigger.read_state(trigger.STATE), '120')
            trigger.tick()
            self.assertEqual(dispatch.call_count, 2)
            self.assertEqual(trigger.read_state(trigger.STATE), '121')
