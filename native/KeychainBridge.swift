import Foundation
import Security
let tag = "jp.hitotsuzutsu.chatgpt.credential-key.v1".data(using: .utf8)!
func key() throws -> SecKey {
 let query: [String:Any] = [kSecClass as String:kSecClassKey,kSecAttrApplicationTag as String:tag,kSecAttrKeyType as String:kSecAttrKeyTypeECSECPrimeRandom,kSecReturnRef as String:true]
 var found: CFTypeRef?;let status = SecItemCopyMatching(query as CFDictionary,&found)
 if status == errSecSuccess, let found = found { return found as! SecKey }
 if status != errSecItemNotFound { throw NSError(domain:"Keychain",code:Int(status)) }
 var error: Unmanaged<CFError>?
 let attributes: [String:Any] = [kSecAttrKeyType as String:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeySizeInBits as String:256,kSecPrivateKeyAttrs as String:[kSecAttrIsPermanent as String:true,kSecAttrApplicationTag as String:tag,kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]]
 guard let generated=SecKeyCreateRandomKey(attributes as CFDictionary,&error) else { throw NSError(domain:"Keychain",code:1) };return generated
}
do {
 let mode=CommandLine.arguments.dropFirst().first ?? ""
 guard ["encrypt","decrypt"].contains(mode) else {exit(2)}
 let input=FileHandle.standardInput.readDataToEndOfFile(); guard input.count < 200000 else {exit(2)}
 let secret=try key();var error:Unmanaged<CFError>?
 let alg=SecKeyAlgorithm.eciesEncryptionCofactorX963SHA256AESGCM
 var output:CFData?
 if mode=="encrypt" {guard let pub=SecKeyCopyPublicKey(secret) else {exit(3)};output=SecKeyCreateEncryptedData(pub,alg,input as CFData,&error)}
 else {output=SecKeyCreateDecryptedData(secret,alg,input as CFData,&error)}
 guard let data=output else {exit(3)};FileHandle.standardOutput.write(data as Data)
} catch {exit(3)}
