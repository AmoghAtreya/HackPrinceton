import { spawn } from 'node:child_process'
import type { Rectangle } from '../../shared/highlight-contracts'

// Observe clicks in other apps without intercepting or synthesizing input.
// AppKit uses a bottom-left origin; Electron uses the primary screen's top-left.
const script = `
ObjC.import('AppKit');
function run(argv) {
  var application = $.NSApplication.sharedApplication;
  application.setActivationPolicy(2);
  var target = JSON.parse(argv[0]);
  var height = $.NSScreen.screens.firstObject.frame.size.height;
  var armed = false;
  var monitor = $.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler(6, function(event) {
    var point = $.NSEvent.mouseLocation;
    var x = point.x, y = height - point.y;
    var inside = x >= target.x && x < target.x + target.width &&
        y >= target.y && y < target.y + target.height;
    if (Number(event.type) === 1) { armed = inside; return; }
    if (armed && inside) {
      $.NSFileHandle.fileHandleWithStandardOutput.writeData($('clicked\\n').dataUsingEncoding($.NSUTF8StringEncoding));
    }
    armed = false;
  });
  if (!monitor) throw new Error('Mouse observation unavailable');
  application.run;
}
`

export function observeTargetClick(target: Rectangle, clicked: () => void): () => void {
  if (process.platform !== 'darwin') return () => {}
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, JSON.stringify(target)], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  let stopped = false
  let output = ''
  const stop = () => {
    if (stopped) return
    stopped = true
    child.stdout.removeAllListeners('data')
    child.kill()
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    output += chunk
    if (!stopped && output.includes('clicked\n')) { stop(); clicked() }
  })
  child.on('error', () => { stop(); console.warn('Highlight click detection unavailable. Use Dismiss highlight.') })
  child.on('exit', () => {
    if (!stopped) { stopped = true; console.warn('Highlight click detection stopped. Use Dismiss highlight.') }
  })
  return stop
}
