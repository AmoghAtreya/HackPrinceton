import { nativeImage } from 'electron'

// A monochrome 2x template icon, drawn in code; macOS adapts it to the menu bar.
export function createTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAa0lEQVR4nO3PMQ4AIAhDUe9/ad2cTBAstUN/wgbJYwzn3G4GI4Gg4aoQOAwFgcC6MCVUNyaFYmGuUVIgNiZEZY9fdkJQ5RsU6IgyyCAWqGuOSWEkQT9QYXIgJiqVFKYb9ZwMBAWjJIFwTr4FxaZhu22XJLgAAAAASUVORK5CYII=', 'base64'), { scaleFactor: 2 })
  icon.setTemplateImage(true)
  return icon
}
