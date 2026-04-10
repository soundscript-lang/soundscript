import AppKit
import Foundation

struct Palette {
  let darkBackground = NSColor(calibratedRed: 0.067, green: 0.067, blue: 0.094, alpha: 1)
  let leftPurple = NSColor(calibratedRed: 0.659, green: 0.333, blue: 0.969, alpha: 1)
  let rightPurple = NSColor(calibratedRed: 0.494, green: 0.133, blue: 0.808, alpha: 1)
  let scriptPurple = NSColor(calibratedRed: 0.659, green: 0.333, blue: 0.969, alpha: 1)
  let badgeBackground = NSColor(calibratedRed: 0.914, green: 0.835, blue: 1.0, alpha: 1)
  let badgeInk = NSColor(calibratedRed: 0.298, green: 0.114, blue: 0.584, alpha: 1)
  let lightWord = NSColor.white
  let darkWord = NSColor(calibratedRed: 0.067, green: 0.067, blue: 0.094, alpha: 1)
}

let palette = Palette()

func makeImage(size: NSSize, draw: () -> Void) -> NSImage {
  let image = NSImage(size: size)
  image.lockFocusFlipped(true)
  NSColor.clear.setFill()
  NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()
  draw()
  image.unlockFocus()
  return image
}

func writePNG(_ image: NSImage, to url: URL) throws {
  guard
    let tiff = image.tiffRepresentation,
    let rep = NSBitmapImageRep(data: tiff),
    let data = rep.representation(using: .png, properties: [:])
  else {
    throw NSError(domain: "render_brand_assets", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode PNG"])
  }

  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try data.write(to: url)
}

func systemFont(size: CGFloat, weight: NSFont.Weight) -> NSFont {
  NSFont.systemFont(ofSize: size, weight: weight)
}

func drawCenteredText(_ text: String, in rect: NSRect, attributes: [NSAttributedString.Key: Any], yOffset: CGFloat = 0) {
  let size = (text as NSString).size(withAttributes: attributes)
  let point = CGPoint(
    x: rect.midX - size.width / 2,
    y: rect.midY - size.height / 2 + yOffset
  )
  (text as NSString).draw(at: point, withAttributes: attributes)
}

func shieldPoint(_ x: CGFloat, _ y: CGFloat, origin: CGPoint, scale: CGFloat) -> CGPoint {
  CGPoint(x: origin.x + x * scale, y: origin.y + y * scale)
}

func scaledRect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat, origin: CGPoint, scale: CGFloat) -> NSRect {
  NSRect(x: origin.x + x * scale, y: origin.y + y * scale, width: width * scale, height: height * scale)
}

func drawShield(at origin: CGPoint, scale: CGFloat, showBadge: Bool) {
  if !showBadge {
    let leftHalf = NSBezierPath()
    leftHalf.move(to: shieldPoint(50, 5, origin: origin, scale: scale))
    leftHalf.line(to: shieldPoint(50, 100, origin: origin, scale: scale))
    leftHalf.curve(
      to: shieldPoint(5, 60, origin: origin, scale: scale),
      controlPoint1: shieldPoint(50, 100, origin: origin, scale: scale),
      controlPoint2: shieldPoint(5, 85, origin: origin, scale: scale)
    )
    leftHalf.line(to: shieldPoint(5, 20, origin: origin, scale: scale))
    leftHalf.close()
    palette.leftPurple.setFill()
    leftHalf.fill()

    let rightHalf = NSBezierPath()
    rightHalf.move(to: shieldPoint(50, 5, origin: origin, scale: scale))
    rightHalf.line(to: shieldPoint(50, 100, origin: origin, scale: scale))
    rightHalf.curve(
      to: shieldPoint(95, 60, origin: origin, scale: scale),
      controlPoint1: shieldPoint(50, 100, origin: origin, scale: scale),
      controlPoint2: shieldPoint(95, 85, origin: origin, scale: scale)
    )
    rightHalf.line(to: shieldPoint(95, 20, origin: origin, scale: scale))
    rightHalf.close()
    palette.rightPurple.setFill()
    rightHalf.fill()
    return
  }

  let leftHalf = NSBezierPath()
  leftHalf.move(to: shieldPoint(50, 5, origin: origin, scale: scale))
  leftHalf.line(to: shieldPoint(50, 100, origin: origin, scale: scale))
  leftHalf.curve(
    to: shieldPoint(5, 60, origin: origin, scale: scale),
    controlPoint1: shieldPoint(50, 100, origin: origin, scale: scale),
    controlPoint2: shieldPoint(5, 85, origin: origin, scale: scale)
  )
  leftHalf.line(to: shieldPoint(5, 20, origin: origin, scale: scale))
  leftHalf.close()
  palette.leftPurple.setFill()
  leftHalf.fill()

  let rightHalf = NSBezierPath()
  rightHalf.move(to: shieldPoint(50, 5, origin: origin, scale: scale))
  rightHalf.line(to: shieldPoint(50, 100, origin: origin, scale: scale))
  rightHalf.curve(
    to: shieldPoint(95, 60, origin: origin, scale: scale),
    controlPoint1: shieldPoint(50, 100, origin: origin, scale: scale),
    controlPoint2: shieldPoint(95, 85, origin: origin, scale: scale)
  )
  rightHalf.line(to: shieldPoint(95, 20, origin: origin, scale: scale))
  rightHalf.close()
  palette.rightPurple.setFill()
  rightHalf.fill()

  drawCenteredText(
    "S",
    in: scaledRect(10, 15, 80, 70, origin: origin, scale: scale),
    attributes: [
      .font: systemFont(size: 62 * scale, weight: .black),
      .foregroundColor: NSColor.white,
    ],
    yOffset: -0.5 * scale
  )

  guard showBadge else {
    return
  }

  let badgeRect = scaledRect(70, 68, 26, 18, origin: origin, scale: scale)
  let badge = NSBezierPath(roundedRect: badgeRect, xRadius: 3 * scale, yRadius: 3 * scale)
  palette.badgeBackground.setFill()
  badge.fill()

  drawCenteredText(
    "ts",
    in: badgeRect,
    attributes: [
      .font: systemFont(size: 13 * scale, weight: .black),
      .foregroundColor: palette.badgeInk,
    ],
    yOffset: -0.3 * scale
  )
}

func wordmarkAttributes(soundColor: NSColor, fontSize: CGFloat) -> NSAttributedString {
  let result = NSMutableAttributedString(
    string: "soundscript",
    attributes: [
      .font: systemFont(size: fontSize, weight: .heavy),
      .kern: -1.5 * (fontSize / 52),
      .foregroundColor: soundColor,
    ]
  )
  result.addAttribute(.foregroundColor, value: palette.scriptPurple, range: NSRange(location: 5, length: 6))
  return result
}

func drawWordmark(at point: CGPoint, scale: CGFloat, soundColor: NSColor) {
  let mark = wordmarkAttributes(soundColor: soundColor, fontSize: 52 * scale)
  mark.draw(at: point)
}

func renderFullLogo(size: NSSize, background: NSColor?, soundColor: NSColor) -> NSImage {
  let horizontalPadding = size.width * 0.04
  let verticalPadding = size.height * 0.08
  let baseWordmark = wordmarkAttributes(soundColor: soundColor, fontSize: 52)
  let baseWordmarkSize = baseWordmark.size()
  let shieldBounds = NSRect(x: 5, y: 5, width: 91, height: 95)
  let gap: CGFloat = 14
  let availableWidth = size.width - horizontalPadding * 2
  let availableHeight = size.height - verticalPadding * 2
  let baseWidth = shieldBounds.width + gap + baseWordmarkSize.width
  let baseHeight = max(shieldBounds.height, baseWordmarkSize.height)
  let scale = min(availableWidth / baseWidth, availableHeight / baseHeight)
  let wordmark = wordmarkAttributes(soundColor: soundColor, fontSize: 52 * scale)
  let wordmarkSize = wordmark.size()
  let totalWidth = shieldBounds.width * scale + gap * scale + wordmarkSize.width
  let totalHeight = max(shieldBounds.height * scale, wordmarkSize.height)
  let contentStartX = (size.width - totalWidth) / 2
  let contentStartY = (size.height - totalHeight) / 2
  let shieldOrigin = CGPoint(
    x: contentStartX - shieldBounds.minX * scale,
    y: contentStartY + (totalHeight - shieldBounds.height * scale) / 2 - shieldBounds.minY * scale
  )
  let wordmarkPoint = CGPoint(
    x: contentStartX + shieldBounds.width * scale + gap * scale,
    y: contentStartY + (totalHeight - wordmarkSize.height) / 2
  )

  return makeImage(size: size) {
    if let background {
      let bg = NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: 16 * scale, yRadius: 16 * scale)
      background.setFill()
      bg.fill()
    }

    drawShield(at: shieldOrigin, scale: scale, showBadge: true)
    wordmark.draw(at: wordmarkPoint)
  }
}

func renderGitHubAvatar(size: NSSize) -> NSImage {
  let iconInset = min(size.width, size.height) * 0.005
  let iconSize = NSSize(width: size.width - iconInset * 2, height: size.height - iconInset * 2)
  let iconImage = renderIcon(size: iconSize, showBadge: true, scaleMultiplier: 1.065)

  return makeImage(size: size) {
    iconImage.draw(
      in: NSRect(
        x: (size.width - iconSize.width) / 2,
        y: (size.height - iconSize.height) / 2,
        width: iconSize.width,
        height: iconSize.height
      )
    )
  }
}

func renderIcon(size: NSSize, showBadge: Bool, scaleMultiplier: CGFloat? = nil) -> NSImage {
  let baseSide: CGFloat = showBadge ? 110 : 112
  let effectiveScaleMultiplier = scaleMultiplier ?? (showBadge ? 0.9 : 0.86)
  let scale = min(size.width, size.height) / baseSide * effectiveScaleMultiplier
  let contentWidth: CGFloat = showBadge ? 101 : 100
  let contentHeight: CGFloat = 100
  let origin = CGPoint(
    x: (size.width - contentWidth * scale) / 2,
    y: (size.height - contentHeight * scale) / 2
  )

  return makeImage(size: size) {
    drawShield(at: origin, scale: scale, showBadge: showBadge)
  }
}

func renderWordmark(soundColor: NSColor) -> NSImage {
  let scale: CGFloat = 3
  let wordmark = wordmarkAttributes(soundColor: soundColor, fontSize: 52 * scale)
  let measured = wordmark.size()
  let size = NSSize(width: ceil(measured.width + 36), height: ceil(measured.height + 24))
  let point = CGPoint(x: 18, y: size.height / 2 - measured.height / 2)

  return makeImage(size: size) {
    wordmark.draw(at: point)
  }
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)

let outputs: [(String, NSImage)] = [
  ("media/brand/logo-dark.png", renderFullLogo(size: NSSize(width: 1800, height: 480), background: palette.darkBackground, soundColor: palette.lightWord)),
  ("media/brand/logo-light.png", renderFullLogo(size: NSSize(width: 1800, height: 480), background: nil, soundColor: palette.darkWord)),
  ("media/brand/icon.png", renderIcon(size: NSSize(width: 512, height: 512), showBadge: true)),
  ("media/brand/github-org-avatar.png", renderGitHubAvatar(size: NSSize(width: 1024, height: 1024))),
  ("media/brand/wordmark-dark.png", renderWordmark(soundColor: palette.lightWord)),
  ("media/brand/wordmark-light.png", renderWordmark(soundColor: palette.darkWord)),
  ("media/brand/icon-vscode.png", renderIcon(size: NSSize(width: 512, height: 512), showBadge: false)),
]

for (relativePath, image) in outputs {
  try writePNG(image, to: root.appending(path: relativePath))
  print("wrote \(relativePath)")
}
