// Prints the CGWindowID of the largest on-screen window whose owning app
// name contains the given substring. Used by CI to screenshot just the app
// window (screencapture -l) so the smoke test can verify render output
// without desktop-wallpaper noise.
// Usage: swift scripts/find-window-id.swift "No Bloat"
import CoreGraphics
import Foundation

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: find-window-id.swift <owner substring>\n".data(using: .utf8)!)
    exit(2)
}
let needle = CommandLine.arguments[1]

guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write("CGWindowListCopyWindowInfo failed\n".data(using: .utf8)!)
    exit(1)
}

var bestId = 0
var bestArea = 0.0
for w in info {
    guard let owner = w["kCGWindowOwnerName"] as? String, owner.contains(needle),
          let id = w["kCGWindowNumber"] as? Int,
          let bounds = w["kCGWindowBounds"] as? [String: Any] else { continue }
    let width = (bounds["Width"] as? Double) ?? 0
    let height = (bounds["Height"] as? Double) ?? 0
    let area = width * height
    if area > bestArea {
        bestArea = area
        bestId = id
    }
}
if bestId == 0 {
    FileHandle.standardError.write("no window found for owner containing \"\(needle)\"\n".data(using: .utf8)!)
    exit(1)
}
print(bestId)
