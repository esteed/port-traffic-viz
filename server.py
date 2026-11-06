"""Port traffic visualizer server.

Counts TCP/UDP bytes per port on this machine using the
Microsoft-Windows-Kernel-Network ETW provider (needs administrator rights)
and streams the counts to a browser view over Server-Sent Events.

    python server.py           live capture (Windows asks for elevation)
    python server.py --demo    simulated traffic, no elevation needed

No third-party packages: ETW is driven through ctypes, the web server is
the standard library's http.server.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import queue
import random
import shutil
import socket
import struct
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen

# In the packaged exe the web files are unpacked next to the bundled modules.
HERE = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
DEFAULT_PORT = 8787
RATES = (20, 10, 5, 2, 1)   # samples a second the view can choose from
DEFAULT_RATE = 20
FASTEST_TICK = 1 / max(RATES)
SESSION_NAME = "PortTrafficViz"

TCP, UDP = 0, 1


# ---------------------------------------------------------------------------
# Byte accumulation
# ---------------------------------------------------------------------------

class Accumulator:
    """Collects bytes per port between ticks.

    Each port maps to [tcp_local, tcp_remote, udp_local, udp_remote, last_pid]:
    bytes where the port was this machine's end of the connection, and bytes
    where it was the peer's end (443 for a browser talking to a website).

    Traffic this app causes itself (the stream from its server to its window,
    and anything its own processes send) is kept apart, so the view can show
    it separately or leave it out.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._reset()

    def _reset(self) -> None:
        self._ports: dict[int, list[int]] = {}
        self._own: dict[int, list[int]] = {}
        self._totals = [0, 0, 0, 0, 0]  # in, out, own in, own out, events

    def add(self, lport: int, rport: int, size: int, proto: int, outbound: bool, pid: int,
            own: bool = False) -> None:
        with self._lock:
            ports = self._own if own else self._ports
            if lport:
                e = ports.get(lport)
                if e is None:
                    e = ports[lport] = [0, 0, 0, 0, 0]
                e[proto * 2] += size
                e[4] = pid
            if rport:
                e = ports.get(rport)
                if e is None:
                    e = ports[rport] = [0, 0, 0, 0, 0]
                e[proto * 2 + 1] += size
                e[4] = pid
            t = self._totals
            k = 1 if outbound else 0
            t[k] += size
            if own:
                t[2 + k] += size
            t[4] += 1

    def drain(self):
        """(ports, own ports, (in, out, own in, own out, events)) since the last call."""
        with self._lock:
            out = self._ports, self._own, tuple(self._totals)
            self._reset()
        return out


# ---------------------------------------------------------------------------
# ETW plumbing (ctypes; layouts are the 64-bit ones)
# ---------------------------------------------------------------------------

ULONG = wintypes.ULONG
ULONG64 = ctypes.c_uint64
USHORT = wintypes.USHORT


class GUID(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]

    @classmethod
    def parse(cls, text: str) -> "GUID":
        u = uuid.UUID(text)
        g = cls(u.time_low, u.time_mid, u.time_hi_version)
        ctypes.memmove(g.Data4, u.bytes[8:], 8)
        return g


class WNODE_HEADER(ctypes.Structure):
    _fields_ = [("BufferSize", ULONG), ("ProviderId", ULONG), ("HistoricalContext", ULONG64),
                ("TimeStamp", ctypes.c_int64), ("Guid", GUID), ("ClientContext", ULONG),
                ("Flags", ULONG)]


class EVENT_TRACE_PROPERTIES(ctypes.Structure):
    _fields_ = [("Wnode", WNODE_HEADER), ("BufferSize", ULONG), ("MinimumBuffers", ULONG),
                ("MaximumBuffers", ULONG), ("MaximumFileSize", ULONG), ("LogFileMode", ULONG),
                ("FlushTimer", ULONG), ("EnableFlags", ULONG), ("AgeLimit", wintypes.LONG),
                ("NumberOfBuffers", ULONG), ("FreeBuffers", ULONG), ("EventsLost", ULONG),
                ("BuffersWritten", ULONG), ("LogBuffersLost", ULONG),
                ("RealTimeBuffersLost", ULONG), ("LoggerThreadId", wintypes.HANDLE),
                ("LogFileNameOffset", ULONG), ("LoggerNameOffset", ULONG)]


class TraceProperties(ctypes.Structure):
    """EVENT_TRACE_PROPERTIES followed by room for the session name."""
    _fields_ = [("props", EVENT_TRACE_PROPERTIES), ("name", ctypes.c_wchar * 256)]


class EVENT_TRACE_HEADER(ctypes.Structure):
    _fields_ = [("Size", USHORT), ("FieldTypeFlags", USHORT), ("Version", ULONG),
                ("ThreadId", ULONG), ("ProcessId", ULONG), ("TimeStamp", ctypes.c_int64),
                ("Guid", GUID), ("ProcessorTime", ULONG64)]


class EVENT_TRACE(ctypes.Structure):
    _fields_ = [("Header", EVENT_TRACE_HEADER), ("InstanceId", ULONG),
                ("ParentInstanceId", ULONG), ("ParentGuid", GUID), ("MofData", ctypes.c_void_p),
                ("MofLength", ULONG), ("ClientContext", ULONG)]


class SYSTEMTIME(ctypes.Structure):
    _fields_ = [(n, wintypes.WORD) for n in ("wYear", "wMonth", "wDayOfWeek", "wDay",
                                             "wHour", "wMinute", "wSecond", "wMilliseconds")]


class TIME_ZONE_INFORMATION(ctypes.Structure):
    _fields_ = [("Bias", wintypes.LONG), ("StandardName", ctypes.c_wchar * 32),
                ("StandardDate", SYSTEMTIME), ("StandardBias", wintypes.LONG),
                ("DaylightName", ctypes.c_wchar * 32), ("DaylightDate", SYSTEMTIME),
                ("DaylightBias", wintypes.LONG)]


class TRACE_LOGFILE_HEADER(ctypes.Structure):
    _fields_ = [("BufferSize", ULONG), ("Version", ULONG), ("ProviderVersion", ULONG),
                ("NumberOfProcessors", ULONG), ("EndTime", ctypes.c_int64),
                ("TimerResolution", ULONG), ("MaximumFileSize", ULONG), ("LogFileMode", ULONG),
                ("BuffersWritten", ULONG), ("LogInstanceGuid", GUID),
                ("LoggerName", ctypes.c_void_p), ("LogFileName", ctypes.c_void_p),
                ("TimeZone", TIME_ZONE_INFORMATION), ("BootTime", ctypes.c_int64),
                ("PerfFreq", ctypes.c_int64), ("StartTime", ctypes.c_int64),
                ("ReservedFlags", ULONG), ("BuffersLost", ULONG)]


class EVENT_DESCRIPTOR(ctypes.Structure):
    _fields_ = [("Id", USHORT), ("Version", ctypes.c_ubyte), ("Channel", ctypes.c_ubyte),
                ("Level", ctypes.c_ubyte), ("Opcode", ctypes.c_ubyte), ("Task", USHORT),
                ("Keyword", ULONG64)]


class EVENT_HEADER(ctypes.Structure):
    _fields_ = [("Size", USHORT), ("HeaderType", USHORT), ("Flags", USHORT),
                ("EventProperty", USHORT), ("ThreadId", ULONG), ("ProcessId", ULONG),
                ("TimeStamp", ctypes.c_int64), ("ProviderId", GUID),
                ("EventDescriptor", EVENT_DESCRIPTOR), ("ProcessorTime", ULONG64),
                ("ActivityId", GUID)]


class EVENT_RECORD(ctypes.Structure):
    _fields_ = [("EventHeader", EVENT_HEADER), ("BufferContext", ULONG),
                ("ExtendedDataCount", USHORT), ("UserDataLength", USHORT),
                ("ExtendedData", ctypes.c_void_p), ("UserData", ctypes.c_void_p),
                ("UserContext", ctypes.c_void_p)]


# The callback receives the EVENT_RECORD address; fields are read at fixed
# offsets because building ctypes objects per event is too slow under load.
EVENT_RECORD_CALLBACK = ctypes.WINFUNCTYPE(None, ctypes.c_void_p)


class EVENT_TRACE_LOGFILEW(ctypes.Structure):
    _fields_ = [("LogFileName", wintypes.LPWSTR), ("LoggerName", wintypes.LPWSTR),
                ("CurrentTime", ctypes.c_int64), ("BuffersRead", ULONG),
                ("ProcessTraceMode", ULONG), ("CurrentEvent", EVENT_TRACE),
                ("LogfileHeader", TRACE_LOGFILE_HEADER), ("BufferCallback", ctypes.c_void_p),
                ("BufferSize", ULONG), ("Filled", ULONG), ("EventsLost", ULONG),
                ("EventRecordCallback", EVENT_RECORD_CALLBACK), ("IsKernelTrace", ULONG),
                ("Context", ctypes.c_void_p)]


OFF_EVENT_ID = EVENT_RECORD.EventHeader.offset + EVENT_HEADER.EventDescriptor.offset + EVENT_DESCRIPTOR.Id.offset
OFF_USER_LEN = EVENT_RECORD.UserDataLength.offset
OFF_USER_DATA = EVENT_RECORD.UserData.offset

WNODE_FLAG_TRACED_GUID = 0x00020000
EVENT_TRACE_REAL_TIME_MODE = 0x00000100
EVENT_TRACE_USE_MS_FLUSH_TIMER = 0x00000010  # FlushTimer is in ms (Windows 8+)
PROCESS_TRACE_MODE_REAL_TIME = 0x00000100
PROCESS_TRACE_MODE_EVENT_RECORD = 0x10000000
EVENT_TRACE_CONTROL_STOP = 1
EVENT_CONTROL_CODE_ENABLE_PROVIDER = 1
TRACE_LEVEL_VERBOSE = 5
ERROR_ALREADY_EXISTS = 183
INVALID_PROCESSTRACE_HANDLE = 0xFFFFFFFFFFFFFFFF

KERNEL_NETWORK_GUID = GUID.parse("7DD42A49-5329-4832-8DFD-43D979153A88")
SESSION_GUID = GUID.parse("5C3E6F0B-8A41-4F0E-9B6D-2D7A1E4C9F31")


def check_layouts() -> None:
    """Fail fast if this Python's struct layouts don't match the Windows SDK."""
    if struct.calcsize("P") != 8:
        raise SystemExit("Port traffic needs 64-bit Python.")
    expected = {EVENT_TRACE_PROPERTIES: 120, EVENT_TRACE_LOGFILEW: 448, EVENT_RECORD: 112,
                TRACE_LOGFILE_HEADER: 280, EVENT_HEADER: 80}
    for cls, size in expected.items():
        actual = ctypes.sizeof(cls)
        if actual != size:
            raise SystemExit(f"Internal error: {cls.__name__} is {actual} bytes, expected {size}.")


def _advapi():
    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    adv.StartTraceW.argtypes = [ctypes.POINTER(ULONG64), wintypes.LPCWSTR, ctypes.c_void_p]
    adv.StartTraceW.restype = ULONG
    adv.ControlTraceW.argtypes = [ULONG64, wintypes.LPCWSTR, ctypes.c_void_p, ULONG]
    adv.ControlTraceW.restype = ULONG
    adv.EnableTraceEx2.argtypes = [ULONG64, ctypes.POINTER(GUID), ULONG, ctypes.c_ubyte,
                                   ULONG64, ULONG64, ULONG, ctypes.c_void_p]
    adv.EnableTraceEx2.restype = ULONG
    adv.OpenTraceW.argtypes = [ctypes.POINTER(EVENT_TRACE_LOGFILEW)]
    adv.OpenTraceW.restype = ULONG64
    adv.ProcessTrace.argtypes = [ctypes.POINTER(ULONG64), ULONG, ctypes.c_void_p, ctypes.c_void_p]
    adv.ProcessTrace.restype = ULONG
    adv.CloseTrace.argtypes = [ULONG64]
    adv.CloseTrace.restype = ULONG
    return adv


class EtwCapture:
    """Real-time ETW session on Microsoft-Windows-Kernel-Network."""

    # event id -> (protocol, outbound, address length). Payload layout for all
    # of these: PID u32, size u32, daddr, saddr, dport u16be, sport u16be, ...
    # saddr:sport is always this machine's end; daddr:dport is the peer.
    EVENTS = {10: (TCP, True, 4), 11: (TCP, False, 4), 26: (TCP, True, 16), 27: (TCP, False, 16),
              42: (UDP, True, 4), 43: (UDP, False, 4), 58: (UDP, True, 16), 59: (UDP, False, 16)}

    def __init__(self, acc: Accumulator, own_port: int = 0, owner_pid: int | None = None) -> None:
        self.acc = acc
        self.adv = _advapi()
        self.session: int | None = None
        self.trace: int | None = None
        self._stopping = False
        self._halt = threading.Event()
        self._callback = EVENT_RECORD_CALLBACK(self._on_event)
        self._logfile = None
        self.names = ProcessNames().get
        # This app's own traffic: its web server's port, and the processes it
        # runs as (this one, plus the window and its browser engine).
        self.own_port = own_port
        self._roots = {os.getpid()} | ({owner_pid} if owner_pid else set())
        self.own_pids = frozenset(self._roots)

    def _props(self) -> TraceProperties:
        tp = TraceProperties()
        p = tp.props
        p.Wnode.BufferSize = ctypes.sizeof(tp)
        p.Wnode.Flags = WNODE_FLAG_TRACED_GUID
        p.Wnode.ClientContext = 1
        p.Wnode.Guid = SESSION_GUID
        p.BufferSize = 64
        p.MinimumBuffers = 8
        p.MaximumBuffers = 64
        # Hand partly filled buffers over every tick; the default 1 s flush
        # would deliver light traffic in once-a-second clumps.
        p.LogFileMode = EVENT_TRACE_REAL_TIME_MODE | EVENT_TRACE_USE_MS_FLUSH_TIMER
        p.FlushTimer = round(FASTEST_TICK * 1000)
        p.LoggerNameOffset = TraceProperties.name.offset
        return tp

    def _stop_session(self) -> int:
        tp = self._props()
        return self.adv.ControlTraceW(0, SESSION_NAME, ctypes.byref(tp), EVENT_TRACE_CONTROL_STOP)

    def start(self) -> None:
        handle = ULONG64()
        tp = self._props()
        rc = self.adv.StartTraceW(ctypes.byref(handle), SESSION_NAME, ctypes.byref(tp))
        if rc == ERROR_ALREADY_EXISTS:  # left over from a run that didn't shut down cleanly
            stop_rc = self._stop_session()
            if stop_rc == 5:  # ERROR_ACCESS_DENIED: not elevated, so say that instead
                rc = stop_rc
            else:
                tp = self._props()
                rc = self.adv.StartTraceW(ctypes.byref(handle), SESSION_NAME, ctypes.byref(tp))
        if rc:
            raise OSError(rc, f"Couldn't start the trace session: {ctypes.FormatError(rc).strip()}")
        self.session = handle.value

        rc = self.adv.EnableTraceEx2(self.session, ctypes.byref(KERNEL_NETWORK_GUID),
                                     EVENT_CONTROL_CODE_ENABLE_PROVIDER, TRACE_LEVEL_VERBOSE,
                                     0xFFFFFFFFFFFFFFFF, 0, 0, None)
        if rc:
            self.stop()
            raise OSError(rc, f"Couldn't enable the network provider: {ctypes.FormatError(rc).strip()}")

        log = EVENT_TRACE_LOGFILEW()
        log.LoggerName = SESSION_NAME
        log.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD
        log.EventRecordCallback = self._callback
        self._logfile = log
        trace = self.adv.OpenTraceW(ctypes.byref(log))
        if trace == INVALID_PROCESSTRACE_HANDLE:
            err = ctypes.get_last_error()
            self.stop()
            raise OSError(err, f"Couldn't open the trace: {ctypes.FormatError(err).strip()}")
        self.trace = trace
        threading.Thread(target=self._pump, name="etw", daemon=True).start()
        threading.Thread(target=self._watch_own, name="own-pids", daemon=True).start()

    def _watch_own(self) -> None:
        """Keep the set of this app's processes current (the browser engine starts its own)."""
        while True:
            try:
                self.own_pids = process_tree(self._roots)
            except OSError:
                pass
            if self._halt.wait(2):
                return

    def _pump(self) -> None:
        handles = (ULONG64 * 1)(self.trace)
        rc = self.adv.ProcessTrace(handles, 1, None, None)
        if rc and not self._stopping:
            print(f"Trace processing stopped: {ctypes.FormatError(rc).strip()}", flush=True)

    def _on_event(self, rec: int) -> None:
        try:
            spec = self.EVENTS.get(ctypes.c_uint16.from_address(rec + OFF_EVENT_ID).value)
            if spec is None:
                return
            proto, outbound, alen = spec
            need = 12 + 2 * alen
            if ctypes.c_uint16.from_address(rec + OFF_USER_LEN).value < need:
                return
            data = ctypes.string_at(ctypes.c_void_p.from_address(rec + OFF_USER_DATA).value, need)
            pid, size = struct.unpack_from("<II", data, 0)
            dport, sport = struct.unpack_from(">HH", data, 8 + 2 * alen)
            # Ours: any socket of this app's processes, and both ends of the
            # loopback connections to its web server (127.0.0.1 only, IPv4).
            own = pid in self.own_pids or (alen == 4 and data[8] == 127
                                           and self.own_port in (sport, dport))
            self.acc.add(sport, dport, size, proto, outbound, pid, own)
        except Exception:  # never let an exception escape into ETW's thread
            pass

    def stop(self) -> None:
        self._stopping = True
        self._halt.set()
        if self.session is not None:
            self._stop_session()
            self.session = None
        if self.trace is not None:
            self.adv.CloseTrace(self.trace)
            self.trace = None


class ProcessNames:
    """pid -> executable name, cached for 30 seconds."""

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

    def __init__(self) -> None:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._open = k32.OpenProcess
        self._open.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self._open.restype = wintypes.HANDLE
        self._query = k32.QueryFullProcessImageNameW
        self._query.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                ctypes.POINTER(wintypes.DWORD)]
        self._query.restype = wintypes.BOOL
        self._close = k32.CloseHandle
        self._close.argtypes = [wintypes.HANDLE]
        self._cache: dict[int, tuple[str, float]] = {}

    def get(self, pid: int) -> str:
        if pid == 0:
            return ""
        if pid == 4:
            return "System"
        now = time.monotonic()
        hit = self._cache.get(pid)
        if hit and now - hit[1] < 30:
            return hit[0]
        name = self._lookup(pid)
        self._cache[pid] = (name, now)
        return name

    def _lookup(self, pid: int) -> str:
        h = self._open(self.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = wintypes.DWORD(len(buf))
            if self._query(h, 0, buf, ctypes.byref(size)):
                return os.path.splitext(os.path.basename(buf.value))[0]
            return ""
        finally:
            self._close(h)


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
                ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]


TH32CS_SNAPPROCESS = 0x00000002
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_k32 = None


def _toolhelp():
    global _k32
    if _k32 is None:
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        for f in (k.Process32FirstW, k.Process32NextW):
            f.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
            f.restype = wintypes.BOOL
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenProcess.restype = wintypes.HANDLE
        k.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        k.GetProcessTimes.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        _k32 = k
    return _k32


def _started(k, pid: int) -> int | None:
    """When a process started (FILETIME ticks), or None if it can't be opened."""
    h = k.OpenProcess(ProcessNames.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None
    try:
        t = [wintypes.FILETIME() for _ in range(4)]
        if not k.GetProcessTimes(h, *(ctypes.byref(x) for x in t)):
            return None
        return (t[0].dwHighDateTime << 32) | t[0].dwLowDateTime
    finally:
        k.CloseHandle(h)


def process_tree(roots) -> frozenset[int]:
    """The given processes and everything they started that's still running."""
    k = _toolhelp()
    snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE_VALUE:
        raise ctypes.WinError(ctypes.get_last_error())
    children: dict[int, list[int]] = {}
    try:
        pe = PROCESSENTRY32W()
        pe.dwSize = ctypes.sizeof(pe)
        ok = k.Process32FirstW(snap, ctypes.byref(pe))
        while ok:
            children.setdefault(pe.th32ParentProcessID, []).append(pe.th32ProcessID)
            ok = k.Process32NextW(snap, ctypes.byref(pe))
    finally:
        k.CloseHandle(snap)
    started = {}
    for pid in roots:
        t = _started(k, pid)
        if t is not None:
            started[pid] = t
    todo = list(started)
    while todo:
        parent = todo.pop()
        for child in children.get(parent, ()):
            if child in started:
                continue
            t = _started(k, child)
            # Windows reuses process IDs, so a process that's older than its
            # "parent" was really started by an earlier holder of that ID.
            if t is not None and t >= started[parent]:
                started[child] = t
                todo.append(child)
    return frozenset(started)


# ---------------------------------------------------------------------------
# Demo traffic
# ---------------------------------------------------------------------------

class Demo:
    """Simulated traffic so the view can be tried without elevation."""

    PROCS = {1101: "chrome", 1102: "msedge", 1103: "Spotify", 1104: "OneDrive", 1105: "svchost",
             1106: "ms-teams", 1107: "Code", 1108: "steam", 1109: "postgres", 4: "System",
             1111: "OUTLOOK", 1112: "ssh", 1113: "TermService"}

    # remote port, protocol, inbound bytes/s, outbound bytes/s, pid, weight
    PROFILES = [
        (443, TCP, 2.5e5, 1.5e4, 1101, 10), (443, TCP, 1.2e5, 1e4, 1102, 4),
        (443, TCP, 4e4, 3e3, 1103, 2), (443, TCP, 2e4, 3e5, 1104, 2),
        (80, TCP, 6e4, 3e3, 1101, 2), (53, UDP, 600, 300, 1105, 6), (123, UDP, 90, 90, 1105, 1),
        (5353, UDP, 400, 400, 1101, 2), (1900, UDP, 300, 200, 1105, 1),
        (3478, UDP, 2e5, 1.8e5, 1106, 1), (22, TCP, 3e3, 1e3, 1112, 1),
        (993, TCP, 2e3, 500, 1111, 1), (5432, TCP, 5e4, 1e4, 1107, 1),
        (8080, TCP, 8e4, 4e3, 1107, 1), (27015, UDP, 4e4, 1.5e4, 1108, 1),
        (5228, TCP, 200, 100, 1101, 1), (445, TCP, 1e5, 2e4, 4, 1),
    ]
    SAME_PORT = {5353, 1900, 137, 138}

    def __init__(self, acc: Accumulator) -> None:
        self.acc = acc
        self.rng = random.Random()
        self.conns: list[dict] = []
        self._stop = threading.Event()
        self.names = lambda pid: self.PROCS.get(pid, "")

    def start(self) -> None:
        threading.Thread(target=self._run, name="demo", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def _ephemeral(self) -> int:
        return self.rng.randint(49152, 65535)

    def _spawn(self) -> None:
        rng = self.rng
        weights = [p[5] for p in self.PROFILES]
        rport, proto, rin, rout, pid, _ = rng.choices(self.PROFILES, weights)[0]
        scale = rng.lognormvariate(0, 0.8)
        lport = rport if rport in self.SAME_PORT else self._ephemeral()
        self.conns.append(dict(l=lport, r=rport, proto=proto, rin=rin * scale, rout=rout * scale,
                               pid=pid, ttl=rng.uniform(3, 45)))

    def _run(self) -> None:
        rng = self.rng
        # Long-lived inbound sessions: this machine is the server on 3389.
        self.conns.append(dict(l=3389, r=rng.randint(50000, 60000), proto=TCP, rin=2e4,
                               rout=1.5e5, pid=1113, ttl=1e9))
        target = 30
        last = time.perf_counter()
        while not self._stop.wait(FASTEST_TICK / 2):
            now = time.perf_counter()
            dt, last = now - last, now
            if rng.random() < dt / 8:
                target = rng.randint(20, 45)
            while len(self.conns) < target:
                self._spawn()
            if rng.random() < dt / 25:  # occasional big download
                self.conns.append(dict(l=self._ephemeral(), r=443, proto=TCP,
                                       rin=rng.uniform(1e7, 3.5e7), rout=2e5,
                                       pid=rng.choice([1108, 1104, 1101]), ttl=rng.uniform(6, 14)))
            for c in list(self.conns):
                c["ttl"] -= dt
                if c["ttl"] <= 0:
                    self.conns.remove(c)
                    continue
                f = rng.uniform(0.3, 1.7)
                b_in, b_out = int(c["rin"] * dt * f), int(c["rout"] * dt * f)
                if b_in:
                    self.acc.add(c["l"], c["r"], b_in, c["proto"], False, c["pid"])
                if b_out:
                    self.acc.add(c["l"], c["r"], b_out, c["proto"], True, c["pid"])


# ---------------------------------------------------------------------------
# Streaming and HTTP
# ---------------------------------------------------------------------------

class Hub:
    """Fans each tick out to every connected browser."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: set[queue.Queue] = set()
        self.last_change = time.monotonic()  # when a viewer last connected or left

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=40)  # 2 s of ticks at the fastest rate
        with self._lock:
            self._subs.add(q)
            self.last_change = time.monotonic()
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subs.discard(q)
            self.last_change = time.monotonic()

    def viewers(self) -> int:
        with self._lock:
            return len(self._subs)

    def publish(self, msg: str) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(msg)
            except queue.Full:  # slow client; it'll catch up on the next tick
                pass


class TickRate:
    """How often counts go out to the view. The view can change it while running."""

    def __init__(self, hz: int = DEFAULT_RATE) -> None:
        self.hz = hz
        self.wake = threading.Event()  # set when the rate changes or the ticker should stop

    @property
    def seconds(self) -> float:
        return 1 / self.hz

    def set(self, hz: int) -> None:
        if hz not in RATES:
            raise ValueError(f"rate must be one of {RATES}")
        if hz != self.hz:
            self.hz = hz
            self.wake.set()


def run_ticker(acc: Accumulator, hub: Hub, names, stop: threading.Event, rate: TickRate) -> None:
    last = time.perf_counter()
    next_t = last + rate.seconds
    report_t, report = last, [0, 0, 0, 0.0]
    while not stop.is_set():
        delay = next_t - time.perf_counter()
        if delay > 0 and rate.wake.wait(delay):
            rate.wake.clear()  # new rate (or stopping): time the next tick from the last one
            next_t = last + rate.seconds
            continue
        now = time.perf_counter()
        dt, last = now - last, now
        next_t = max(next_t + rate.seconds, now)
        ports, own, (b_in, b_out, own_in, own_out, events) = acc.drain()
        rows = [[p, e[0], e[1], e[2], e[3], names(e[4])] for p, e in ports.items()]
        own_rows = [[p, e[0], e[1], e[2], e[3]] for p, e in own.items()]
        hub.publish(json.dumps({"dt": round(dt, 4), "t": rate.seconds, "in": b_in, "out": b_out,
                                "si": own_in, "so": own_out, "p": rows, "s": own_rows},
                               separators=(",", ":")))
        report[0] += events
        report[1] += b_in
        report[2] += b_out
        report[3] += dt
        if now - report_t >= 10:
            span = report[3] or 1
            print(f"{time.strftime('%H:%M:%S')}  {report[0] / span:,.0f} events/s   "
                  f"in {fmt_bits(report[1] * 8 / span)}   out {fmt_bits(report[2] * 8 / span)}   "
                  f"{len(ports)} ports this tick", flush=True)
            report_t, report = now, [0, 0, 0, 0.0]


def fmt_bits(bps: float) -> str:
    for unit, div in (("Gb/s", 1e9), ("Mb/s", 1e6), ("kb/s", 1e3)):
        if bps >= div:
            return f"{bps / div:.1f} {unit}"
    return f"{bps:.0f} b/s"


STATIC = {"/": ("index.html", "text/html; charset=utf-8"),
          "/index.html": ("index.html", "text/html; charset=utf-8"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/style.css": ("style.css", "text/css; charset=utf-8")}


class CountingWriter:
    """Passes writes through to a connection and reports how many bytes went out."""

    def __init__(self, raw, count) -> None:
        self._raw, self._count = raw, count

    def write(self, b) -> int:
        n = self._raw.write(b)
        self._count(len(b))
        return n

    def __getattr__(self, name):
        return getattr(self._raw, name)


def make_handler(hub: Hub, info: dict, port: int, rate: TickRate, on_write=None):
    """on_write(bytes, client_port) is called for everything sent, when no capture sees it."""
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    allowed_origins = {f"http://{h}" for h in allowed_hosts}

    class Handler(BaseHTTPRequestHandler):
        server_version = "PortTraffic/1.0"

        def log_message(self, fmt, *args):  # keep the console for status lines
            pass

        def setup(self):
            super().setup()
            if on_write:
                client_port = self.client_address[1]
                self.wfile = CountingWriter(self.wfile, lambda n: on_write(n, client_port))

        def _ours(self) -> bool:
            # Only answer to our own origin, so other web pages can't read this
            # machine's traffic through DNS rebinding.
            if self.headers.get("Host") in allowed_hosts:
                return True
            self.send_error(403)
            return False

        def do_GET(self):
            if not self._ours():
                return
            path = self.path.split("?", 1)[0]
            if path == "/events":
                self._events()
            elif path == "/api/info":
                body = json.dumps({**info, "tick": rate.seconds}).encode()
                self._send(200, "application/json", body)
            elif path in STATIC:
                name, ctype = STATIC[path]
                try:
                    with open(os.path.join(WEB_DIR, name), "rb") as f:
                        self._send(200, ctype, f.read())
                except OSError:
                    self.send_error(404)
            else:
                self.send_error(404)

        def do_POST(self):
            # POST /api/rate {"hz": 5} sets how many samples a second are sent.
            # Requiring a JSON body and our own Origin keeps other web pages
            # from changing it: they can't send JSON here without a CORS
            # preflight, which this server doesn't answer.
            if not self._ours():
                return
            if self.path.split("?", 1)[0] != "/api/rate":
                self.send_error(404)
                return
            origin = self.headers.get("Origin")
            ctype = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if (origin is not None and origin not in allowed_origins) or ctype != "application/json":
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 256:
                    raise ValueError("bad length")
                rate.set(int(json.loads(self.rfile.read(length))["hz"]))
            except (ValueError, KeyError, TypeError):
                self.send_error(400)
                return
            self._send(200, "application/json", json.dumps({"tick": rate.seconds}).encode())

        def _send(self, code: int, ctype: str, body: bytes) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _events(self) -> None:
            q = hub.subscribe()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(b"retry: 2000\n\n")
                self.wfile.flush()
                while True:
                    try:
                        msg = q.get(timeout=15)
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    else:
                        self.wfile.write(b"data: " + msg.encode() + b"\n\n")
                    self.wfile.flush()
            except OSError:  # browser went away
                pass
            finally:
                hub.unsubscribe(q)

    return Handler


# ---------------------------------------------------------------------------
# Service names
# ---------------------------------------------------------------------------

EXTRA_SERVICES = {1194: "openvpn", 1900: "ssdp", 3306: "mysql", 3478: "stun", 5228: "gcm",
                  5353: "mdns", 5355: "llmnr", 5432: "postgresql", 6379: "redis",
                  7680: "delivery-opt", 8080: "http-alt", 8443: "https-alt", 9092: "kafka",
                  9200: "elasticsearch", 27015: "steam", 27017: "mongodb", 51820: "wireguard"}
OVERRIDES = {53: "dns", 3389: "rdp", 445: "smb"}


def load_services() -> dict[int, str]:
    path = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "drivers", "etc", "services")
    out: dict[int, str] = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                parts = line.split("#", 1)[0].split()
                if len(parts) >= 2 and "/" in parts[1]:
                    num = parts[1].split("/", 1)[0]
                    if num.isdigit():
                        out.setdefault(int(num), parts[0])
    except OSError:
        pass
    for p, name in EXTRA_SERVICES.items():
        out.setdefault(p, name)
    out.update(OVERRIDES)
    return out


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except OSError:
        return False


def free_port(start: int) -> int:
    for p in range(start, start + 50):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit(f"No free port found between {start} and {start + 49}.")


def wait_for_server(url: str, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            with urlopen(url + "api/info", timeout=1):
                return True
        except OSError:
            time.sleep(0.5)
    return False


def relaunch_elevated(args) -> int:
    """Start an elevated copy of this server, then open the browser from here.

    The copy runs from %LOCALAPPDATA% because elevated processes can't always
    see drive letters mounted in the user's session (Google Drive, mapped
    network drives). The browser is opened from this unelevated process so it
    doesn't run as administrator.
    """
    port = free_port(args.port)
    dest = os.path.join(os.environ.get("LOCALAPPDATA") or HERE, "PortTrafficViz")
    os.makedirs(dest, exist_ok=True)
    shutil.copy2(os.path.abspath(__file__), os.path.join(dest, "server.py"))
    shutil.copytree(WEB_DIR, os.path.join(dest, "web"), dirs_exist_ok=True)

    shell32 = ctypes.WinDLL("shell32")
    shell32.ShellExecuteW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                      wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_int]
    shell32.ShellExecuteW.restype = ctypes.c_void_p
    params = f'"{os.path.join(dest, "server.py")}" --port {port} --elevated'
    rc = shell32.ShellExecuteW(None, "runas", sys.executable, params, dest, 1) or 0
    if rc <= 32:
        print("Live capture needs administrator rights, and elevation was cancelled or failed.")
        print("To try the view with simulated traffic instead:  python server.py --demo")
        return 1

    url = f"http://127.0.0.1:{port}/"
    print(f"Started the capture server in a new administrator window.\nWaiting for {url} ...")
    if not wait_for_server(url, 90):
        print("The capture server didn't respond. Check the administrator window for an error.")
        return 1
    print(f"Running. Open {url} (close the administrator window to stop).")
    if not args.no_browser:
        webbrowser.open(url)
    return 0


def install_close_handler(cleanup) -> None:
    """Stop the ETW session when the console window is closed, not just on Ctrl+C."""
    handler_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)

    def handler(_ctrl_type):
        cleanup()
        return False  # let Python's own handling (KeyboardInterrupt) run too

    install_close_handler._ref = handler_type(handler)  # keep the callback alive
    ctypes.windll.kernel32.SetConsoleCtrlHandler(install_close_handler._ref, True)


class Server:
    """A traffic source (live ETW or demo) plus the local web server streaming it.

    Used by serve() below and by the desktop app (desktop.py).
    """

    def __init__(self, mode: str, port: int, exact_port: bool = False,
                 owner_pid: int | None = None) -> None:
        """owner_pid: the window's process, when capture runs in a separate helper."""
        self.mode = mode
        self.port = port if exact_port else free_port(port)
        self.acc = Accumulator()
        self.hub = Hub()
        self.rate = TickRate()
        if mode == "demo":
            self.source = Demo(self.acc)
            on_write = self._count_own_stream  # nothing captures the real stream in demo mode
        else:
            self.source = EtwCapture(self.acc, own_port=self.port, owner_pid=owner_pid)
            on_write = None
        self.source.start()
        self.done = threading.Event()
        try:
            info = {"mode": mode, "rates": list(RATES), "host": socket.gethostname(),
                    "services": load_services()}
            self.httpd = ThreadingHTTPServer(
                ("127.0.0.1", self.port), make_handler(self.hub, info, self.port, self.rate, on_write))
        except BaseException:
            self.source.stop()
            raise
        self.httpd.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.port}/"
        threading.Thread(target=run_ticker,
                         args=(self.acc, self.hub, self.source.names, self.done, self.rate),
                         name="ticker", daemon=True).start()

    def _count_own_stream(self, size: int, client_port: int) -> None:
        # What a capture would see: this server's socket sending, the window's receiving.
        pid = os.getpid()
        self.acc.add(self.port, client_port, size, TCP, True, pid, own=True)
        self.acc.add(client_port, self.port, size, TCP, False, pid, own=True)

    def stop_capture(self) -> None:
        if not self.done.is_set():
            self.done.set()
            self.rate.wake.set()
            self.source.stop()

    def run(self) -> None:
        """Serve until shutdown() is called from another thread (or Ctrl+C)."""
        try:
            self.httpd.serve_forever(poll_interval=0.5)
        finally:
            self.stop_capture()
            self.httpd.server_close()

    def shutdown(self) -> None:
        self.stop_capture()
        self.httpd.shutdown()


def serve(args, mode: str) -> int:
    srv = Server(mode, args.port, exact_port=args.elevated)
    install_close_handler(srv.stop_capture)
    label = "simulated traffic" if mode == "demo" else "live capture of this machine's TCP and UDP traffic"
    print(f"Port traffic: {label}\nServing {srv.url}  (Ctrl+C or close this window to stop)", flush=True)
    if not args.no_browser and not args.elevated:
        threading.Timer(0.3, webbrowser.open, (srv.url,)).start()
    try:
        srv.run()
    except KeyboardInterrupt:
        pass
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Live isometric view of per-port network traffic.")
    ap.add_argument("--demo", action="store_true", help="simulate traffic instead of capturing it")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="local web port (default 8787)")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    ap.add_argument("--elevated", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    check_layouts()
    if args.demo:
        return serve(args, "demo")
    if not is_admin():
        return relaunch_elevated(args)
    return serve(args, "live")


if __name__ == "__main__":
    elevated = "--elevated" in sys.argv
    try:
        code = main()
    except SystemExit as stop:
        if isinstance(stop.code, str):
            print(stop.code)
            code = 1
        else:
            code = stop.code or 0
    except BaseException:
        traceback.print_exc()
        code = 1
    if elevated and code:
        # This window was opened for us; keep it up so the error can be read.
        input("\nPress Enter to close this window.")
    sys.exit(code)
