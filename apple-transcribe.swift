// Transcribe audio files with macOS 26 on-device SpeechAnalyzer. Prints one JSON object per file.
// Usage: swift apple-transcribe.swift <file>...

import AVFoundation
import Foundation
import Speech

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

func transcribe(_ path: String) async throws -> String {
    let transcriber = SpeechTranscriber(
        locale: Locale(identifier: "en-US"),
        transcriptionOptions: [],
        reportingOptions: [],
        attributeOptions: []
    )
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))

    async let text = transcriber.results.reduce(into: "") { partial, result in
        partial += String(result.text.characters)
    }
    if let lastSample = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: lastSample)
    } else {
        await analyzer.cancelAndFinishNow()
    }
    return try await text.trimmingCharacters(in: .whitespacesAndNewlines)
}

for path in CommandLine.arguments.dropFirst() {
    do {
        emit(["file": path, "text": try await transcribe(path)])
    } catch {
        emit(["file": path, "error": "\(error)"])
    }
}
