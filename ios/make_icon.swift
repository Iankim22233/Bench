// Draws the 1024x1024 app icon: pine silhouettes against a golden-hour sky.
// Usage: swift make_icon.swift <output.png>
import AppKit

let size = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.png"
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                    space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
let S = CGFloat(size)

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: 1) }

// sky (CG origin is bottom-left)
let sky = CGGradient(colorsSpace: cs, colors: [rgb(0.99, 0.72, 0.38), rgb(0.86, 0.45, 0.42), rgb(0.27, 0.22, 0.42)] as CFArray,
                     locations: [0, 0.45, 1])!
ctx.drawLinearGradient(sky, start: CGPoint(x: 0, y: S * 0.3), end: CGPoint(x: 0, y: S), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])

// sun glow
let glow = CGGradient(colorsSpace: cs, colors: [CGColor(srgbRed: 1, green: 0.95, blue: 0.75, alpha: 1),
                                                CGColor(srgbRed: 1, green: 0.8, blue: 0.5, alpha: 0)] as CFArray, locations: [0, 1])!
let sun = CGPoint(x: S * 0.5, y: S * 0.42)
ctx.drawRadialGradient(glow, startCenter: sun, startRadius: 0, endCenter: sun, endRadius: S * 0.42, options: [])
ctx.setFillColor(rgb(1, 0.97, 0.86))
ctx.fillEllipse(in: CGRect(x: sun.x - S * 0.075, y: sun.y - S * 0.075, width: S * 0.15, height: S * 0.15))

// layered pine silhouettes, far (hazy) to near (dark)
func pine(_ x: CGFloat, _ base: CGFloat, _ h: CGFloat, _ color: CGColor) {
    ctx.setFillColor(color)
    let w = h * 0.36
    ctx.fill(CGRect(x: x - w * 0.06, y: base, width: w * 0.12, height: h * 0.25))
    for i in 0..<5 {
        let f = CGFloat(i) / 5
        let bot = base + h * (0.15 + 0.68 * f)
        let top = i == 4 ? base + h : bot + h * 0.34
        let r = w * (1 - f * 0.75)
        ctx.beginPath()
        ctx.move(to: CGPoint(x: x - r, y: bot))
        ctx.addLine(to: CGPoint(x: x + r, y: bot))
        ctx.addLine(to: CGPoint(x: x, y: top))
        ctx.closePath()
        ctx.fillPath()
    }
}
let layers: [(CGFloat, CGFloat, CGColor, [CGFloat])] = [
    (S * 0.30, S * 0.26, rgb(0.55, 0.36, 0.40), [0.08, 0.2, 0.33, 0.68, 0.8, 0.93]),
    (S * 0.20, S * 0.40, rgb(0.27, 0.19, 0.25), [0.0, 0.16, 0.78, 0.97]),
    (S * 0.08, S * 0.62, rgb(0.07, 0.08, 0.08), [0.12, 0.88]),
]
for (base, h, col, xs) in layers {
    ctx.setFillColor(col)
    ctx.fill(CGRect(x: 0, y: 0, width: S, height: base + 2))
    for x in xs { pine(S * x, base, h, col) }
}

let img = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
