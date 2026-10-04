import Foundation
import AVFoundation
import Speech
func emit(_ value:[String:Any]) {if let data=try? JSONSerialization.data(withJSONObject:value),let s=String(data:data,encoding:.utf8){print(s);fflush(stdout)}}
let recognizer=SFSpeechRecognizer(locale:Locale(identifier:"ja-JP"))
if CommandLine.arguments.contains("inspect") {emit(["available":recognizer != nil,"onDevice":recognizer?.supportsOnDeviceRecognition ?? false]);exit(0)}
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
