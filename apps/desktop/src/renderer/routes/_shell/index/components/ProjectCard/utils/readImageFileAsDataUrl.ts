const MAX_BYTES = 1_000_000
const MAX_EDGE = 640

/** Keep animated GIF bytes intact and reject large files before FileReader runs. */
function readGif(file: File): Promise<string> {
  if (file.size > MAX_BYTES) {
    return Promise.reject(new Error("GIF thumbnails must be 1 MB or smaller."))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result)
      else reject(new Error("Could not read this GIF."))
    }
    reader.onerror = () => reject(new Error("Could not read this GIF."))
    reader.onabort = () => reject(new Error("GIF loading was cancelled."))
    reader.readAsDataURL(file)
  })
}

/** Decode a still through the browser, then encode a bounded, aspect-safe PNG. */
function readStill(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const sourceEdge = Math.max(image.naturalWidth, image.naturalHeight)
      if (sourceEdge < 1) {
        reject(new Error("Could not decode this image."))
        return
      }
      let edge = Math.min(sourceEdge, MAX_EDGE)
      while (edge >= 1) {
        const scale = edge / sourceEdge
        const canvas = document.createElement("canvas")
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const context = canvas.getContext("2d")
        if (!context) {
          reject(new Error("Could not process this image."))
          return
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL("image/png")
        const encoded = dataUrl.split(",", 2)[1] ?? ""
        if (Math.floor((encoded.length * 3) / 4) <= MAX_BYTES) {
          resolve(dataUrl)
          return
        }
        edge = Math.floor(edge * 0.75)
      }
      reject(new Error("Could not fit this image within 1 MB."))
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error("Could not decode this image."))
    }
    image.src = objectUrl
  })
}

/** Normalize a chosen image before it crosses IPC or replaces stored artwork. */
export function readImageFileAsDataUrl(file: File): Promise<string> {
  if (file.type === "image/gif") return readGif(file)
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    return Promise.reject(new Error("Choose a PNG, JPEG, WebP, or GIF image."))
  }
  return readStill(file)
}
