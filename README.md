# Port traffic

A live isometric view of network traffic on this Windows machine, one bar per port.

- Ports 1–1024 are a 32 × 32 block of 5 px bars in front.
- Ports 1025–65535 are a 256 × 252 field of 2 px bars behind it, 256 ports per row.
  The darker band is the ephemeral range, 49152–65535: the short-lived local ports
  Windows assigns to outgoing connections.
- Bar height shows traffic on a log scale, from 100 b/s up to the scale you pick.
  Color runs from blue for light traffic through violet to red for heavy traffic.
- White is traffic the app causes itself, stacked on top of everything else on that
  port. **Hide own traffic** leaves it out of the bars, the totals and the list.
- Traffic is sampled 20 times a second by default. **Samples** changes that to 10, 5,
  2 or 1 a second. Each bar shows the average over about the last half second, or
  over one sample at 2 or 1 a second.
- The **Busiest ports** list updates once a second. Click a port there to pin it:
  pinned ports stay at the top of the list and are outlined on the grid until you
  click them again. You can pin as many as you like.
- Scroll the mouse wheel over the grid to zoom in and out around the pointer, and
  drag with the left button to move around. **Reset view** goes back to the start.
- The sample rate and the Hide own traffic setting are remembered between runs.

## Run it

Download `PortTraffic.exe` from the
[latest release](https://github.com/esteed/port-traffic-viz/releases/latest), or
build it yourself (see below).

| | |
|---|---|
| `PortTraffic.exe` | The desktop app. Windows asks for administrator rights, then the view opens in its own window. Close the window to stop. |
| `PortTraffic.exe --demo` | Simulated traffic, no administrator rights needed. |
| `start.cmd`, `start-demo.cmd` | The same view in your browser instead, run from source (needs Python). |

The exe needs nothing installed. It uses the Edge WebView2 runtime that comes with Windows 11.

If you decline the administrator prompt, the window offers **Try again** or
**Show simulated traffic**.

## Build the exe

Run `build.cmd`. It needs 64-bit Python 3.10 or later and, the first time, an
internet connection: it sets up pywebview, PyInstaller and Pillow in
`%LOCALAPPDATA%\PortTrafficViz\build` (outside Google Drive) and writes
`dist\PortTraffic.exe`. Rebuild after editing anything in `web\`, `server.py` or
`desktop.py`.

## How it works

`server.py` starts a real-time ETW session on the `Microsoft-Windows-Kernel-Network`
provider, which reports every TCP and UDP send and receive with its byte count,
local port, remote port and process ID. It adds those up per port and pushes a
summary to the view at the chosen sample rate over Server-Sent Events.

The app's own traffic is mostly that stream, from the capture process to the
window over 127.0.0.1. Capture counts as its own any traffic on loopback
connections to its own web server port, plus anything sent by its own processes:
the capture process, the window and the window's browser engine (WebView2). In
demo mode nothing is captured, so the server counts the bytes it sends instead.

`desktop.py` is the app. Its window runs with your normal rights. Capture runs in
a second, elevated copy of the exe that has no window and quits when the window
closes. If you start the exe as administrator, capture runs in the window's own
process instead.

Each connection has two ports. A browser fetching a web page uses a dynamic local
port (say 52814) and remote port 443. The **Both ends** filter counts those bytes
at both ports, **Local** only at 52814, and **Remote** only at 443.

The server only listens on 127.0.0.1 and refuses requests whose `Host` header
isn't its own address.

## Notes

- For live capture, the program copies itself to `%LOCALAPPDATA%\PortTrafficViz`
  and runs the elevated copy from there, because elevated processes can't always
  see Google Drive or mapped network drive letters.
- The exe isn't code-signed. Some antivirus products are wary of PyInstaller
  executables in general; if yours quarantines it, add an exception or use
  `start.cmd` instead.
- This shows traffic to and from this machine's own sockets, not other devices
  on your network.
- Under very heavy traffic (hundreds of thousands of packets a second), Python
  can fall behind and ETW drops events, so the bars read low.
