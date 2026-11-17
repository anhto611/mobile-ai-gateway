// React Native example. Works the same in Expo.
// npm install mobile-ai-gateway-client @react-native-async-storage/async-storage
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createGateway, GatewayError } from 'mobile-ai-gateway-client';
import { useState } from 'react';
import { Button, Text, TextInput, View } from 'react-native';

/** A random id created on first launch. Reinstalling the app gives a new one. */
async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem('ai-device-id');
  if (!id) {
    id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    await AsyncStorage.setItem('ai-device-id', id);
  }
  return id;
}

export const ai = createGateway({
  baseUrl: 'https://mobile-ai-gateway.<your-subdomain>.workers.dev',
  deviceId: getDeviceId,
  // With react-native-iap or RevenueCat, return `ios:<transactionId>` or
  // `android:<productId>:<purchaseToken>` for paying users, null otherwise.
  getPurchaseProof: async () => null,
});

interface Summary {
  title: string;
  summary: string;
  tags: string[];
}

export function SummarizeBox() {
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');

  async function onSummarize() {
    try {
      const { data, usage } = await ai.run<Summary>('summarize', { text });
      setMessage(`${data.title}\n\n${data.summary}\n\n${usage.remaining ?? 'Unlimited'} summaries left today.`);
    } catch (err) {
      if (err instanceof GatewayError && err.code === 'quota_exceeded') {
        setMessage('You have used all free summaries for today. Upgrade for more.');
      } else if (err instanceof GatewayError && err.retryable) {
        setMessage('The AI is busy. Try again in a moment.');
      } else {
        setMessage('Could not summarize that. Try a shorter text.');
      }
    }
  }

  return (
    <View>
      <TextInput value={text} onChangeText={setText} placeholder="Paste an article or a long message" multiline />
      <Button title="Summarize" onPress={onSummarize} />
      <Text>{message}</Text>
    </View>
  );
}

// Receipt scan: pass base64 from your image picker, resized to about 1600px.
export async function scanReceipt(base64Jpeg: string) {
  return ai.run('scan-receipt', {}, { image: { data: base64Jpeg, mimeType: 'image/jpeg' } });
}
