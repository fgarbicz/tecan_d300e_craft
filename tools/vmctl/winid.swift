import CoreGraphics
let title = CommandLine.arguments[1]
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerName as String] as? String ?? "").contains("VMware") && (w[kCGWindowName as String] as? String) == title {
  print(w[kCGWindowNumber as String]!); break
}
