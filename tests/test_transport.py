"""Offline regressions. Every vendor DLL entry point is replaced by a fake."""
import ctypes
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources'))
import j2534 as j
import uds
import j2534_monitor as monitor


class Function:
    def __init__(self, fn): self.fn = fn
    def __call__(self, *args): return self.fn(*args)


def put(pointer, value):
    ctypes.cast(pointer, ctypes.POINTER(j.U))[0] = value


class FakeDll:
    def __init__(self):
        self.calls = []
        self.rx = []
        self.read_status = 0
        self.filter_status = 0
        for name in ('Open', 'Close', 'Connect', 'Disconnect', 'ReadMsgs', 'WriteMsgs',
                     'StartMsgFilter', 'StopMsgFilter', 'ReadVersion', 'GetLastError', 'Ioctl'):
            setattr(self, 'PassThru' + name, Function(getattr(self, name)))

    def Open(self, name, out):
        self.calls.append('open'); put(out, 10); return 0
    def Close(self, dev): self.calls.append('close'); return 0
    def Connect(self, dev, proto, flags, bitrate, out):
        self.calls.append(('connect', proto, bitrate)); put(out, 20); return 0
    def Disconnect(self, chan): self.calls.append('disconnect'); return 0
    def ReadVersion(self, dev, fw, dll, api):
        fw.value = b'legacy'; dll.value = b'1.01.0.4341'; api.value = b'04.04'; return 0
    def GetLastError(self, out): out.value = b'fake driver failure'; return 0
    def Ioctl(self, *args): self.calls.append(('ioctl', args[1])); return 0
    def StopMsgFilter(self, *args): return 0
    def StartMsgFilter(self, chan, kind, mask, pattern, flow, out):
        self.filter = (kind,) + tuple(bytes(p._obj.Data[:p._obj.DataSize]) for p in (mask, pattern, flow))
        self.flow_flags = flow._obj.TxFlags
        put(out, 30); return self.filter_status
    def WriteMsgs(self, chan, msg, count, timeout):
        m = msg._obj
        self.tx = (bytes(m.Data[:m.DataSize]), m.TxFlags)
        put(count, 1); return 0
    def ReadMsgs(self, chan, messages, count, timeout):
        count_value = min(count._obj.value, len(self.rx))
        for i in range(count_value):
            payload, flags = self.rx.pop(0)
            messages[i].ProtocolID = j.PROTO_ISO15765
            messages[i].RxStatus = flags
            messages[i].DataSize = len(payload)
            messages[i].Data[:len(payload)] = payload
        put(count, count_value)
        return self.read_status


class DriverTests(unittest.TestCase):
    def setUp(self):
        self.dll = FakeDll()
        self.loader = patch.object(j.ctypes, 'WinDLL', return_value=self.dll, create=True)
        self.loader.start(); self.addCleanup(self.loader.stop)
        self.dev = j.J2534Device('offline-fake.dll')

    def test_open_configures_engine_and_tcu_filters(self):
        for request, response in ((0x7E0, 0x7E8), (0x7E1, 0x7E9)):
            self.dev.open(request_id=request, response_id=response)
            self.assertEqual(self.dll.filter, (3, b'\xff' * 4, response.to_bytes(4, 'big'), request.to_bytes(4, 'big')))
            self.assertEqual(self.dll.flow_flags, 0x40)
            self.dev.close()
        self.assertEqual(ctypes.sizeof(j.PassThruMsg), 4152)

    def test_write_preserves_zero_bytes(self):
        self.dev.channel_id = 20
        self.dev.write_frame(0x7E0, bytes.fromhex('2200F100'))
        self.assertEqual(self.dll.tx, (bytes.fromhex('000007E02200F100'), 0x40))

    def test_partial_timeout_keeps_received_payload_and_drops_indicators(self):
        self.dev.channel_id = 20
        self.dll.rx = [(bytes.fromhex('000007E8'), j.START_OF_MESSAGE),
                       (bytes.fromhex('000007E822F190'), j.TX_MSG_TYPE),
                       (bytes.fromhex('000007E862F190004100'), 0)]
        self.dll.read_status = j.ERR_TIMEOUT
        self.assertEqual(self.dev.read_frames(max_msgs=8), [(0x7E8, bytes.fromhex('62F190004100'))])

    def test_empty_read_and_oversize_write(self):
        self.dev.channel_id = 20
        self.dll.read_status = j.ERR_BUFFER_EMPTY
        self.assertEqual(self.dev.read_frames(), [])
        with self.assertRaises(ValueError): self.dev.write_frame(0x7E0, b'a' * 4096)

    def test_transport_closes_partial_open(self):
        self.dll.filter_status = 7
        with patch.object(uds, 'select_passthru_dll', return_value='offline-fake.dll'):
            transport = uds.J2534Transport()
            with self.assertRaisesRegex(uds.TransportError, 'fake driver failure'): transport.open()
        self.assertEqual(self.dll.calls[-2:], ['disconnect', 'close'])
        self.assertIsNone(transport._device)

    def test_dll_load_error_is_transport_error(self):
        with patch.object(uds, 'select_passthru_dll', return_value='offline-fake.dll'), \
             patch.object(j.ctypes, 'WinDLL', side_effect=OSError('blocked by Windows')):
            with self.assertRaisesRegex(uds.TransportError, 'blocked by Windows'):
                uds.J2534Transport().open()

    def test_pending_and_positive_in_same_read_are_both_consumed(self):
        transport = uds.J2534Transport()
        transport._device = Mock()
        transport._device.read_frames.return_value = [(0x7E8, bytes.fromhex('7F2278')), (0x7E8, bytes.fromhex('62F1904100'))]
        self.assertEqual(uds.UdsClient(transport).read_did(0xF190), b'A\x00')
        transport._device.read_frames.assert_called_once()

    def test_empty_indicator_batch_does_not_prematurely_timeout(self):
        transport = uds.J2534Transport()
        transport._device = Mock()
        transport._device.read_frames.side_effect = [[], [(0x7E8, b'answer')]]
        self.assertEqual(transport.read(0x7E8, 1000), b'answer')


class PreflightTests(unittest.TestCase):
    def setUp(self):
        # Any accidental native load fails the test before touching USB.
        guard = patch.object(j.ctypes, 'WinDLL', side_effect=AssertionError('native DLL load forbidden'), create=True)
        guard.start(); self.addCleanup(guard.stop)
        env = patch.dict(os.environ, {}, clear=True); env.start(); self.addCleanup(env.stop)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / 'legacy.dll')
        bits = uds.python_bitness()
        header = bytearray(132)
        header[:2] = b'MZ'; struct.pack_into('<I', header, 0x3c, 64)
        header[64:68] = b'PE\0\0'; struct.pack_into('<H', header, 68, 0x14c if bits == 32 else 0x8664)
        Path(self.path).write_bytes(header)
        self.reg = patch.object(uds, 'passthru_registrations', return_value=[{'name': 'Legacy', 'dll': self.path, 'view': f'{bits}-bit'}])
        self.reg.start(); self.addCleanup(self.reg.stop)

    def test_preflight_inspects_without_loading_driver(self):
        self.assertTrue(uds.preflight()['ready'])
        self.assertEqual(uds.preflight()['dll'], self.path)

    def test_missing_registration_is_actionable(self):
        with patch.object(uds, 'passthru_registrations', return_value=[]):
            self.assertIn('No J2534 PassThru device is registered', uds.preflight()['message'])

    def test_wrong_architecture_recommends_python_not_driver_update(self):
        other = 64 if uds.python_bitness() == 32 else 32
        with patch.object(uds, 'dll_bitness', return_value=other):
            message = uds.preflight()['message']
        self.assertIn('VWD_PYTHON', message)
        self.assertIn('keep your existing driver', message)

    def test_hash_pin_rejects_changed_driver(self):
        with patch.dict(os.environ, {'VWD_J2534_SHA256': '0' * 64}):
            self.assertFalse(uds.preflight()['ready'])
            self.assertIn('pinned SHA256', uds.preflight()['message'])

    def test_explicit_missing_dll_does_not_fall_back(self):
        with patch.dict(os.environ, {'VWD_J2534_DLL': self.path + '.missing'}):
            self.assertFalse(uds.preflight()['ready'])

    def test_multiple_drivers_require_explicit_selection(self):
        regs = uds.passthru_registrations() + [{'name': 'Other', 'dll': 'other.dll', 'view': f'{uds.python_bitness()}-bit'}]
        with patch.object(uds, 'passthru_registrations', return_value=regs):
            self.assertIn('Multiple J2534', uds.preflight()['message'])
            with patch.dict(os.environ, {'VWD_J2534_DLL': self.path}):
                self.assertTrue(uds.preflight()['ready'])

    def test_monitor_open_failure_retains_original_error(self):
        events = []
        with patch.object(uds.J2534Transport, 'open', side_effect=uds.TransportError('driver blocker')), \
             patch.object(monitor, 'emit', side_effect=events.append), patch('sys.stdin', io.StringIO('')):
            monitor.run(None, 2, 1)
        self.assertTrue(any(e.get('phase') == 'error' and 'driver blocker' in e['message'] for e in events))


class ProtocolTests(unittest.TestCase):
    def client(self, *responses):
        transport = Mock()
        # After the scripted frames the bus goes quiet: read() times out.
        transport.read.side_effect = list(responses) + [None] * 8
        return uds.UdsClient(transport)

    def test_multiple_four_byte_dtcs_keep_failure_type_and_status(self):
        records = self.client(bytes.fromhex('5902FF0299008820021104')).read_dtcs()
        self.assertEqual([(d['code'], d['failureType'], d['statusByte']) for d in records], [('P0299', 0, 0x88), ('P2002', 0x11, 4)])
        self.assertEqual(uds.format_dtc(0xDA00), 'U1A00')

    def test_malformed_and_wrong_service_or_did_are_rejected(self):
        for payload in (b'', bytes.fromhex('7F22'), bytes.fromhex('61F190'), bytes.fromhex('62F1914100')):
            with self.subTest(payload=payload), self.assertRaises(uds.TransportError):
                self.client(payload).read_did(0xF190)
        with self.assertRaises(uds.TransportError): self.client(bytes.fromhex('5902FF029988')).read_dtcs()

    def test_width_mismatch_nulls_live_value(self):
        values = self.client(bytes.fromhex('62F40C010203')).read_live({'rpm': uds.DID_MAP['rpm']})
        self.assertIsNone(values['rpm'])

    def test_isotp_large_payload_wraps_sequence_through_zero(self):
        payload = bytes(range(256)) * 2
        frames = uds.tp_encode(payload)
        self.assertEqual(frames[0][:2], bytes.fromhex('1200'))
        self.assertEqual(frames[16][0], 0x20)
        decoder = uds.TpDecoder()
        decoded = None
        for frame in frames: decoded = decoder.feed(frame) or decoded
        self.assertEqual(decoded, payload)
        decoder.feed(frames[0])
        with self.assertRaises(ValueError): decoder.feed(frames[2])

    def test_unanswered_candidate_channels_remain_null(self):
        client = Mock(); client.read_live.return_value = {'rpm': 800}
        transport = monitor.RealTransport(client)
        result = transport.sample(0)
        for key in uds.DID_CANDIDATES: self.assertIsNone(result[key])

    def test_monitor_closes_transport_on_initial_read_failure(self):
        transport = Mock(); transport.read_info.side_effect = RuntimeError('unplugged')
        with patch.object(monitor, 'open_real_transport', return_value=transport), \
             patch.object(monitor, 'emit'), patch.object(monitor, 'start_command_worker'):
            monitor.run(None, 2, 1)
        transport.close.assert_called_once()


class SessionResilienceTests(unittest.TestCase):
    def stub_client(self, dtcs=(), fail_clear=False):
        client = Mock()
        client.read_did.side_effect = uds.TransportError('unsupported')
        client.read_vin.return_value = 'WV1ZZZ2H0JW123456'
        client.read_dtcs.return_value = list(dtcs)
        client.read_live.side_effect = lambda did_map: {name: 1 for name in did_map}
        if fail_clear:
            client.clear_dtcs.side_effect = uds.TransportError('negative response 0x22')
        return client

    def run_session(self, transport, stdin_lines):
        events = []
        with patch.object(monitor, 'open_real_transport', return_value=transport), \
             patch.object(monitor, 'emit', side_effect=events.append), \
             patch.object(monitor, 'LIVE_INTERVAL_S', 0.01), \
             patch('sys.stdin', io.StringIO(''.join(json.dumps(l) + '\n' for l in stdin_lines))):
            monitor.run(0.3, 2, 1)
        return events

    def test_refused_command_is_logged_and_session_continues(self):
        transport = monitor.RealTransport(self.stub_client(fail_clear=True))
        transport.client.transport = Mock()
        events = self.run_session(transport, [{'cmd': 'clear_dtc'}])
        messages = [e.get('message', '') for e in events]
        self.assertTrue(any("Command 'clear_dtc' failed" in m for m in messages))
        self.assertFalse(any(e.get('phase') == 'error' for e in events))

    def test_extended_session_refusal_is_not_fatal(self):
        client = self.stub_client()
        client.enter_session.side_effect = uds.TransportError('negative response 0x7F')
        with patch.object(monitor, 'emit'):
            info = monitor.RealTransport(client).read_info()
        self.assertEqual(info['vin'], 'WV1ZZZ2H0JW123456')

    def test_clear_reports_codes_present_before(self):
        record = {'code': 'P0299', 'statusByte': 0x08}
        transport = monitor.RealTransport(self.stub_client(dtcs=[record]))
        self.assertEqual(transport.clear_dtcs(), 1)

    def test_stop_request_skips_remaining_live_reads(self):
        client = self.stub_client()
        transport = monitor.RealTransport(client)
        transport.stop_event.set()
        values = transport.sample(0)
        client.read_live.assert_not_called()
        self.assertTrue(all(v is None for v in values.values()))


class InterfaceStatusTests(unittest.TestCase):
    def test_blocked_driver_is_named_in_open_error(self):
        blocked = [{'instanceId': 'USB\\VID_0403&PID_CC4D\\X', 'code': 39, 'detail': uds.DEVICE_PROBLEMS[39]}]
        with patch.object(uds, 'select_passthru_dll', return_value='op20pt32.dll'), \
             patch.object(j, 'J2534Device', side_effect=OSError('device not connected')), \
             patch.object(uds, 'interface_device_problems', return_value=blocked):
            with self.assertRaises(uds.TransportError) as ctx:
                uds.J2534Transport().open()
        self.assertIn('Code 39', str(ctx.exception))
        self.assertIn('device not connected', str(ctx.exception))

    def test_no_hint_when_interface_is_healthy(self):
        with patch.object(uds, 'interface_device_problems', return_value=[]):
            self.assertEqual(uds.interface_problem_hint(), '')

    def test_device_status_lookup_is_inert_off_windows(self):
        if sys.platform != 'win32':
            self.assertEqual(uds.interface_device_problems(), [])


if __name__ == '__main__': unittest.main()
