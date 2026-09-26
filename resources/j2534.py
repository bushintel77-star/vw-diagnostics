"""Minimal J2534-1 (v04.04) ctypes wrapper for Windows.

Written for this project after `pyj2534` turned out not to exist on PyPI.
Implements only what resources/uds.py's transport interface needs:

    open() -> connect ISO15765 @ 500 kbps + flow-control filter
    write(can_id, data)   /  read(can_id, timeout_ms)  /  close()

The vendor J2534 DLL (from the CD / seller-supplied driver) does ISO-TP
segmentation and flow control in firmware. No Tactrix software is required
or used — any registered PassThruSupport.04.04 DLL works.

Device enumeration reads the standard registry key:
    HKLM\\SOFTWARE\\PassThruSupport.04.04\\<Vendor>\\FunctionLibrary
    HKLM\\SOFTWARE\\Wow6432Node\\PassThruSupport.04.04\\...   (32-bit view)
"""

import ctypes
import struct
import sys

from ctypes import byref, c_char_p, c_void_p, create_string_buffer

# Windows ULONG is always 32 bits, including when offline tests run on Linux.
U = ctypes.c_uint32

# --- J2534 constants (SAE J2534-1 v04.04, cross-checked against a reference
# implementation — protocol/filter/config IDs live in spec-reserved ranges
# and silently break live mode when wrong) ---------------------------------

STATUS_NOERROR = 0x00000000
ERR_TIMEOUT = 0x00000009      # ReadMsgs returns this when the buffer is
                              # empty at timeout — normal idle, not an error
ERR_BUFFER_OVERFLOW = 0x12
ERR_BUFFER_EMPTY = 0x10
TX_MSG_TYPE = 0x01
START_OF_MESSAGE = 0x02
TX_INDICATION = 0x08

PROTO_CAN = 0x00000005
PROTO_ISO15765 = 0x00000006

FLOW_CONTROL_FILTER = 0x00000003

IOCTL_GET_CONFIG = 0x01
IOCTL_SET_CONFIG = 0x02
IOCTL_CLEAR_TX_BUFFER = 0x07
IOCTL_CLEAR_RX_BUFFER = 0x08

PARAM_DATA_RATE = 0x01
PARAM_LOOPBACK = 0x03

CAN_29BIT_ID = 0x00000100
ISO15765_FRAME_PAD = 0x00000040

PASS_THRU_MSG_DATA_LEN = 4128


class J2534Error(RuntimeError):
    """A J2534 API call returned a non-success status."""

    def __init__(self, status: int, detail: str = ""):
        self.status = status
        super().__init__(
            f"J2534 error 0x{status:08X}" + (f": {detail}" if detail else "")
        )


class PassThruMsg(ctypes.Structure):
    """PASSTHRU_MSG — packed per the J2534-1 header."""

    _pack_ = 1
    _fields_ = [
        ("ProtocolID", U),
        ("RxStatus", U),
        ("TxFlags", U),
        ("Timestamp", U),
        ("DataSize", U),
        ("ExtraDataIndex", U),
        # c_char arrays are returned as NUL-terminated bytes by ctypes.
        # CAN IDs start with NULs, so use an unsigned byte buffer instead.
        ("Data", ctypes.c_ubyte * PASS_THRU_MSG_DATA_LEN),
    ]


class SConfig(ctypes.Structure):
    """SCONFIG — (Parameter, Value) pair."""

    _pack_ = 1
    _fields_ = [
        ("Parameter", U),
        ("Value", U),
    ]


class SConfigList(ctypes.Structure):
    """SCONFIG_LIST — NumOfArgs + pointer to SCONFIG array."""

    _fields_ = [
        ("NumOfArgs", U),
        ("ConfigPtr", ctypes.POINTER(SConfig)),
    ]


def _bind(dll, name, restype, argtypes):
    fn = getattr(dll, name)
    fn.restype = restype
    fn.argtypes = argtypes
    return fn


class J2534Device:
    """A single loaded J2534 DLL bound to one open device/channel."""

    def __init__(self, dll_path: str):
        # J2534 DLLs use stdcall; WinDLL on 64-bit Python can only load a
        # 64-bit DLL, so a bitness mismatch raises here with a clear trace.
        self.device_id = None
        self.channel_id = None
        self._dll = ctypes.WinDLL(dll_path)
        self._bind_functions()

    def _bind_functions(self):
        self._PassThruOpen = _bind(
            self._dll, "PassThruOpen", U, [c_void_p, ctypes.POINTER(U)])
        self._PassThruClose = _bind(
            self._dll, "PassThruClose", U, [U])
        self._PassThruConnect = _bind(
            self._dll, "PassThruConnect", U, [U, U, U, U, ctypes.POINTER(U)])
        self._PassThruDisconnect = _bind(
            self._dll, "PassThruDisconnect", U, [U])
        self._PassThruReadMsgs = _bind(
            self._dll, "PassThruReadMsgs", U,
            [U, ctypes.POINTER(PassThruMsg), ctypes.POINTER(U), U])
        self._PassThruWriteMsgs = _bind(
            self._dll, "PassThruWriteMsgs", U,
            [U, ctypes.POINTER(PassThruMsg), ctypes.POINTER(U), U])
        self._PassThruStartMsgFilter = _bind(
            self._dll, "PassThruStartMsgFilter", U,
            [U, U, ctypes.POINTER(PassThruMsg), ctypes.POINTER(PassThruMsg),
             ctypes.POINTER(PassThruMsg), ctypes.POINTER(U)])
        self._PassThruStopMsgFilter = _bind(
            self._dll, "PassThruStopMsgFilter", U, [U, U])
        self._PassThruReadVersion = _bind(
            self._dll, "PassThruReadVersion", U,
            [U, c_char_p, c_char_p, c_char_p])
        self._PassThruGetLastError = _bind(
            self._dll, "PassThruGetLastError", U, [c_char_p])
        self._PassThruIoctl = _bind(
            self._dll, "PassThruIoctl", U, [U, U, c_void_p, c_void_p])

    # -- error helper -------------------------------------------------------

    def _last_error_text(self) -> str:
        buf = create_string_buffer(256)
        try:
            self._PassThruGetLastError(buf)
            return buf.value.decode("ascii", errors="replace")
        except Exception:
            return ""

    def _check(self, status: int, what: str) -> None:
        if status != STATUS_NOERROR:
            raise J2534Error(status, f"{what}: {self._last_error_text()}")

    # -- lifecycle ----------------------------------------------------------

    def open(self, bitrate: int = 500000, response_id: int = 0x7E8,
             request_id: int = 0x7E0):
        """Open the first device, connect ISO15765, set the flow-control
        filter so multi-frame responses reassemble in firmware."""
        dev = U(0)
        self._check(self._PassThruOpen(None, byref(dev)), "PassThruOpen")
        self.device_id = dev.value

        fw = create_string_buffer(80)
        dll_v = create_string_buffer(80)
        api = create_string_buffer(80)
        self._check(
            self._PassThruReadVersion(self.device_id, fw, dll_v, api),
            "PassThruReadVersion")
        self.versions = {
            "firmware": fw.value.decode("ascii", errors="replace"),
            "dll": dll_v.value.decode("ascii", errors="replace"),
            "api": api.value.decode("ascii", errors="replace"),
        }

        chan = U(0)
        self._check(
            self._PassThruConnect(
                self.device_id, PROTO_ISO15765, 0, bitrate, byref(chan)),
            "PassThruConnect")
        self.channel_id = chan.value
        self.response_id = response_id

        # LOOPBACK off so we never read back our own transmissions
        configs = (SConfig * 1)(SConfig(PARAM_LOOPBACK, 0))
        cfg_list = SConfigList(1, configs)
        self._check(
            self._PassThruIoctl(
                self.channel_id, IOCTL_SET_CONFIG,
                byref(cfg_list), None),
            "Ioctl SET_CONFIG")

        # J2534 uses a four-byte big-endian CAN ID even for 11-bit CAN.
        # Firmware generates flow control on the tester's request ID.
        mask = PassThruMsg()
        mask.ProtocolID = PROTO_ISO15765
        mask.DataSize = 4
        mask.Data[:4] = b"\xff" * 4
        pattern = PassThruMsg()
        pattern.ProtocolID = PROTO_ISO15765
        pattern.DataSize = 4
        pattern.Data[:4] = struct.pack(">I", response_id)
        flow = PassThruMsg()
        flow.ProtocolID = PROTO_ISO15765
        flow.TxFlags = ISO15765_FRAME_PAD
        flow.DataSize = 4
        flow.Data[:4] = struct.pack(">I", request_id)
        fid = U(0)
        self._check(
            self._PassThruStartMsgFilter(
                self.channel_id, FLOW_CONTROL_FILTER,
                byref(mask), byref(pattern), byref(flow), byref(fid)),
            "PassThruStartMsgFilter")
        self.filter_id = fid.value

    def read_version(self) -> dict:
        return getattr(self, "versions", {})

    def close(self):
        if self.channel_id is not None:
            try:
                self._PassThruDisconnect(self.channel_id)
            except Exception:
                pass
            self.channel_id = None
        if self.device_id is not None:
            try:
                self._PassThruClose(self.device_id)
            except Exception:
                pass
            self.device_id = None

    # -- message I/O ---------------------------------------------------------

    def clear_rx(self):
        self._check(self._PassThruIoctl(
            self.channel_id, IOCTL_CLEAR_RX_BUFFER, None, None), "Ioctl CLEAR_RX_BUFFER")

    def write_frame(self, can_id: int, data: bytes, timeout_ms: int = 1000):
        """Transmit one CAN frame (payload without the ID field)."""
        if self.channel_id is None:
            raise J2534Error(0xFFFFFFFF, "channel not open")
        msg = PassThruMsg()
        msg.ProtocolID = PROTO_ISO15765
        msg.TxFlags = ISO15765_FRAME_PAD
        payload = struct.pack(">I", can_id) + data
        if not data or len(data) > 4095:
            raise ValueError("ISO15765 payload must contain 1..4095 bytes")
        msg.DataSize = len(payload)
        msg.Data[:len(payload)] = payload
        num = U(1)
        self._check(
            self._PassThruWriteMsgs(
                self.channel_id, byref(msg), byref(num), timeout_ms),
            "PassThruWriteMsgs")
        if num.value != 1:
            raise J2534Error(ERR_TIMEOUT, "PassThruWriteMsgs accepted no message")

    def read_frames(self, timeout_ms: int = 1000, max_msgs: int = 1):
        """Read up to max_msgs frames; returns list[(can_id, payload)].
        Empty list on timeout."""
        if self.channel_id is None:
            raise J2534Error(0xFFFFFFFF, "channel not open")
        msgs = (PassThruMsg * max_msgs)()
        num = U(max_msgs)
        status = self._PassThruReadMsgs(
            self.channel_id, msgs, byref(num), timeout_ms)
        # A timed-out bulk read may still have returned some messages.
        if status not in (STATUS_NOERROR, ERR_TIMEOUT, ERR_BUFFER_EMPTY):
            self._check(status, "PassThruReadMsgs")
        out = []
        for i in range(min(num.value, max_msgs)):
            m = msgs[i]
            if (m.ProtocolID != PROTO_ISO15765
                    or m.RxStatus & (TX_MSG_TYPE | START_OF_MESSAGE | TX_INDICATION)):
                continue
            if not 4 < m.DataSize <= PASS_THRU_MSG_DATA_LEN:
                continue
            can_id = struct.unpack(">I", bytes(m.Data[:4]))[0]
            out.append((can_id, bytes(m.Data[4:m.DataSize])))
        return out


def enumerate_devices() -> dict:
    """Return {vendor_name: dll_path} from the registry. Reads both the
    native and the Wow6432Node (32-bit) view; annotate 32-bit entries since
    64-bit Python cannot load them."""
    if sys.platform != "win32":
        raise RuntimeError("J2534 enumeration requires Windows")
    import winreg

    is64 = sys.maxsize > 2**32
    found = {}
    views = [
        (winreg.KEY_WOW64_64KEY if is64 else 0, ""),
        (winreg.KEY_WOW64_32KEY, " [32-bit DLL]" if is64 else ""),
    ]
    for access, suffix in views:
        try:
            base = winreg.OpenKeyEx(
                winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\PassThruSupport.04.04",
                0, winreg.KEY_READ | access)
        except OSError:
            continue
        with base:
            count = winreg.QueryInfoKey(base)[0]
            for i in range(count):
                try:
                    name = winreg.EnumKey(base, i)
                    with winreg.OpenKeyEx(base, name, 0,
                                          winreg.KEY_READ | access) as dev:
                        dll = winreg.QueryValueEx(dev, "FunctionLibrary")[0]
                except OSError:
                    continue
                label = name + suffix
                if label not in found:
                    found[label] = dll
    return found
