import {readFile,readdir,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';import {execFileSync} from 'node:child_process';import path from 'node:path';
const root=path.resolve('.');const base='vendor/siwc/packages/local/src';await mkdir('vendor/siwc/dist',{recursive:true});
for(const file of await readdir(base)){if(file.endsWith('.ts')){const source=await readFile(path.join(base,file),'utf8');await writeFile('vendor/siwc/dist/'+file.replace(/\.ts$/,'.js'),stripTypeScriptTypes(source,{mode:'strip'}));}}
await mkdir('bin/VoiceBridge.app/Contents/MacOS',{recursive:true});
const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>jp.hitotsuzutsu.voicebridge</string><key>CFBundleName</key><string>ひとつずつ 音声</string><key>CFBundleExecutable</key><string>VoiceBridge</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/><key>NSMicrophoneUsageDescription</key><string>会話のためにマイクを使います。音声認識はこのMac上で行います。</string><key>NSSpeechRecognitionUsageDescription</key><string>話した内容をこのMac上で文字にし、ChatGPTとの会話に使います。</string></dict></plist>`;
await writeFile('bin/VoiceBridge.app/Contents/Info.plist',plist);
execFileSync('/usr/bin/swiftc',['-swift-version','5','native/KeychainBridge.swift','-o','bin/KeychainBridge'],{stdio:'inherit'});
execFileSync('/usr/bin/swiftc',['-swift-version','5','native/VoiceBridge.swift','-o','bin/VoiceBridge.app/Contents/MacOS/VoiceBridge'],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--force','--sign','-','bin/VoiceBridge.app'],{stdio:'inherit'});
console.log('Built local sign-in and on-device speech helpers');
