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

interface Expense {
  amount: number;
  currency: string;
  category: string;
  note: string;
  date: string;
}

export function QuickAdd() {
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');

  async function onAdd() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data, usage } = await ai.run<Expense>('parse-expense', { text, today, currency: 'USD' });
      setMessage(`${data.note}: ${data.amount} ${data.currency} (${data.category}). ${usage.remaining ?? 'Unlimited'} left today.`);
    } catch (err) {
      if (err instanceof GatewayError && err.code === 'quota_exceeded') {
        setMessage('You have used all free AI entries for today. Upgrade for more.');
      } else if (err instanceof GatewayError && err.retryable) {
        setMessage('The AI is busy. Try again in a moment.');
      } else {
        setMessage('Could not read that. Try writing it differently.');
      }
    }
  }

  return (
    <View>
      <TextInput value={text} onChangeText={setText} placeholder="Lunch 12.50 with Sam" />
      <Button title="Add" onPress={onAdd} />
      <Text>{message}</Text>
    </View>
  );
}

// Receipt scan: pass base64 from your image picker, resized to about 1600px.
export async function scanReceipt(base64Jpeg: string) {
  return ai.run('scan-receipt', {}, { image: { data: base64Jpeg, mimeType: 'image/jpeg' } });
}
