// Evaluates JS files in the system JavaScriptCore framework, the same
// engine WKWebView uses (the jsc shell binary is inside the sealed dyld
// cache on modern macOS, so it can't be invoked directly). Any JS exception
// exits nonzero. Usage: swift scripts/run-jsc.swift file1.js file2.js ...
import Foundation
import JavaScriptCore

let ctx = JSContext()!
ctx.exceptionHandler = { _, exc in
    let msg = exc?.toString() ?? "unknown JS exception"
    FileHandle.standardError.write(("JS exception: " + msg + "\n").data(using: .utf8)!)
    exit(1)
}
let printFn: @convention(block) (String) -> Void = { s in print(s) }
ctx.setObject(printFn, forKeyedSubscript: "print" as NSString)

for path in CommandLine.arguments.dropFirst() {
    guard let src = try? String(contentsOfFile: path, encoding: .utf8) else {
        FileHandle.standardError.write("cannot read \(path)\n".data(using: .utf8)!)
        exit(1)
    }
    ctx.evaluateScript(src, withSourceURL: URL(fileURLWithPath: path))
}
