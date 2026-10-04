import Foundation
import AVFoundation
import Speech
import Darwin

// A LaunchServices app cannot inherit Node's stdout pipe. Connect before asking
// for permission; loss of this private channel always ends microphone use.
if let index=CommandLine.arguments.firstIndex(of:"--socket") {
 guard CommandLine.arguments.indices.contains(index+1) else{exit(1)}
 let socketPath=CommandLine.arguments[index+1]
 var address=sockaddr_un();address.sun_family=sa_family_t(AF_UNIX)
 let bytes=Array(socketPath.utf8CString)
 guard bytes.count<=MemoryLayout.size(ofValue:address.sun_path) else{exit(1)}
 withUnsafeMutableBytes(of:&address.sun_path){target in bytes.withUnsafeBytes{target.copyBytes(from:$0)}}
 let fd=socket(AF_UNIX,SOCK_STREAM,0);guard fd>=0 else{exit(1)}
 let connected=withUnsafePointer(to:&address){pointer in pointer.withMemoryRebound(to:sockaddr.self,capacity:1){Darwin.connect(fd,$0,socklen_t(MemoryLayout<sockaddr_un>.size))}}
 guard connected==0,dup2(fd,STDOUT_FILENO)>=0 else{exit(1)}
 DispatchQueue.global().async{var byte:UInt8=0;_ = Darwin.read(fd,&byte,1);exit(0)}
}
func emit(_ value:[String:Any]) {if let data=try? JSONSerialization.data(withJSONObject:value),let s=String(data:data,encoding:.utf8){print(s);fflush(stdout)}}
let recognizer=SFSpeechRecognizer(locale:Locale(identifier:"ja-JP"))
if CommandLine.arguments.contains("inspect") {emit(["type":"inspection","available":recognizer != nil,"onDevice":recognizer?.supportsOnDeviceRecognition ?? false,"bundleId":Bundle.main.bundleIdentifier ?? "","microphonePermission":AVCaptureDevice.authorizationStatus(for:.audio).rawValue,"speechPermission":SFSpeechRecognizer.authorizationStatus().rawValue]);exit(0)}
let engine=AVAudioEngine();var speechRequest:SFSpeechAudioBufferRecognitionRequest?;var speechTask:SFSpeechRecognitionTask?;var stopped=false;var restarting=false;var turn=0
func fail(_ code:String) -> Never {emit(["type":"error","code":code]);exit(1)}
func beginRecognition(){
 guard !stopped else{return};turn += 1;let current=turn
 let request=SFSpeechAudioBufferRecognitionRequest();request.shouldReportPartialResults=true;request.requiresOnDeviceRecognition=true;request.taskHint = .dictation;speechRequest=request
 speechTask=recognizer?.recognitionTask(with:request){result,error in
  guard current==turn && !stopped else{return}
  if let result=result {emit(["type":"transcript","turn":current,"text":result.bestTranscription.formattedString,"final":result.isFinal]);if result.isFinal && !restarting {restart()}}
  if error != nil && !restarting {if let result=result, !result.bestTranscription.formattedString.isEmpty {restart()}else{fail("recognition_unavailable")}}
 }
}
func restart(){restarting=true;speechTask?.cancel();speechRequest?.endAudio();DispatchQueue.main.asyncAfter(deadline:.now()+0.2){restarting=false;beginRecognition()}}
func start(){
 guard recognizer?.supportsOnDeviceRecognition == true else {fail("on_device_unavailable")}
 let input=engine.inputNode;let format=input.outputFormat(forBus:0);guard format.sampleRate>0 && format.channelCount>0 else {fail("no_microphone")}
 input.installTap(onBus:0,bufferSize:1024,format:format){buffer,_ in speechRequest?.append(buffer)}
 beginRecognition();engine.prepare();do {try engine.start();emit(["type":"ready","onDevice":true])}catch{fail("microphone_unavailable")}
}
SFSpeechRecognizer.requestAuthorization {status in
 guard status == .authorized else{fail("speech_permission")}
 AVCaptureDevice.requestAccess(for:.audio){allowed in DispatchQueue.main.async {if allowed {start()}else{fail("microphone_permission")}}}
}
RunLoop.main.run()
