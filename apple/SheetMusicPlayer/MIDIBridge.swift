import CoreMIDI
import Foundation

/// Listens to every MIDI keyboard connected to the device (USB, Bluetooth, network) with Core MIDI.
final class MIDIBridge {
    /// A channel message (note on/off, pedal…): status byte and two data bytes. Called on the main queue.
    var onMessage: ((UInt8, UInt8, UInt8) -> Void)?
    /// The names of the connected keyboards, whenever they change. Called on the main queue.
    var onDevices: (([String]) -> Void)?

    private var client = MIDIClientRef()
    private var port = MIDIPortRef()
    private var sources = Set<MIDIEndpointRef>()

    /// Start listening (the first time) and report the connected keyboards.
    func start() {
        if client == 0 {
            MIDIClientCreateWithBlock("Sheet Music Player" as CFString, &client) { [weak self] _ in
                // something was plugged in, removed or renamed
                DispatchQueue.main.async { self?.refresh() }
            }
            MIDIInputPortCreateWithProtocol(client, "Input" as CFString, ._1_0, &port) { [weak self] list, _ in
                self?.receive(list)
            }
        }
        refresh()
    }

    private func refresh() {
        var names: [String] = []
        var current = Set<MIDIEndpointRef>()
        for i in 0..<MIDIGetNumberOfSources() {
            let source = MIDIGetSource(i)
            guard source != 0 else { continue }
            current.insert(source)
            if !sources.contains(source) { MIDIPortConnectSource(port, source, nil) }
            var name: Unmanaged<CFString>?
            MIDIObjectGetStringProperty(source, kMIDIPropertyDisplayName, &name)
            names.append((name?.takeRetainedValue() as String?) ?? "MIDI keyboard")
        }
        sources = current
        onDevices?(names)
    }

    /// Runs on Core MIDI's own thread. Messages arrive as Universal MIDI Packets.
    private func receive(_ list: UnsafePointer<MIDIEventList>) {
        var messages: [(UInt8, UInt8, UInt8)] = []
        for packet in list.unsafeSequence() {
            let count = Int(packet.pointee.wordCount)
            let words = UnsafeRawPointer(packet)
                .advanced(by: MemoryLayout<MIDIEventPacket>.offset(of: \.words)!)
                .assumingMemoryBound(to: UInt32.self)
            var i = 0
            while i < count {
                let word = words[i]
                let kind = word >> 28
                // type 2 is a MIDI 1.0 channel message: 0x2g ss d1 d2
                if kind == 2 {
                    messages.append((UInt8((word >> 16) & 0xFF), UInt8((word >> 8) & 0x7F), UInt8(word & 0x7F)))
                }
                i += Self.packetWords[Int(kind)]
            }
        }
        guard !messages.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            for m in messages { self?.onMessage?(m.0, m.1, m.2) }
        }
    }

    /// How many 32-bit words a Universal MIDI Packet of each type takes.
    private static let packetWords = [1, 1, 1, 2, 2, 4, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4]
}
