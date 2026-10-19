// Default game configuration used the first time the server starts.
// Palette sampled from the PharmKulen logo.
export const PALETTE = {
  blue: '#19B2FF',
  sky: '#62DBFF',
  turquoise: '#44E4BC',
  green: '#11BD9B',
  teal: '#058F9A',
  deepTeal: '#06636B',
};

export function defaultConfig() {
  return {
    branding: {
      title: 'Spin',
      tagline: 'Spin the wheel for a little something from PharmKulen.',
      instructions: [
        'Tap the wheel or the Spin button (or press Space) to start.',
        'Wait for the wheel to stop at the pointer.',
        'If you land on a gift, show your claim code to a PharmKulen team member.',
      ],
      spinButtonLabel: 'Spin',
      logo: null, // null = /assets/pharmkulen-logo.png
      icon: null, // null = /assets/pharmkulen-icon.png
      disclaimer:
        'Just for fun. Gifts are small promotional items with no cash value, are subject to availability, and no outcome is guaranteed.',
    },
    availability: {
      enabled: true,
      closedMessage: 'The wheel is resting right now. Please check back soon!',
      startAt: null,
      endAt: null,
      spinsPerDevicePerDay: 1,
      limitPeriod: 'total', // one spin per name + phone number; new players need new details
    },
    showOdds: true,
    collectDetails: true,
    wheelStyle: 'classic',
    segments: [
      { id: 'seg-tote', label: 'Tote Bag', description: 'A reusable PharmKulen tote bag.', color: PALETTE.teal, weight: 5, quantity: 20, isPrize: true },
      { id: 'seg-try1', label: 'Try Again', description: 'Not this time. Thanks for playing!', color: PALETTE.sky, weight: 25, quantity: null, isPrize: false },
      { id: 'seg-sani', label: 'Hand Sanitizer', description: 'A pocket-size hand sanitizer.', color: PALETTE.green, weight: 12, quantity: 50, isPrize: true },
      { id: 'seg-tip', label: 'Health Tip', description: 'Drink water regularly and keep moving every day!', color: PALETTE.blue, weight: 20, quantity: null, isPrize: false },
      { id: 'seg-mask', label: 'Face Masks', description: 'A small pack of face masks.', color: PALETTE.turquoise, weight: 12, quantity: 50, isPrize: true },
      { id: 'seg-try2', label: 'Try Again', description: 'So close! Thanks for playing!', color: PALETTE.deepTeal, weight: 25, quantity: null, isPrize: false },
      { id: 'seg-bottle', label: 'Water Bottle', description: 'A PharmKulen water bottle.', color: PALETTE.blue, weight: 3, quantity: 10, isPrize: true },
      { id: 'seg-sticker', label: 'Sticker', description: 'A cheerful PharmKulen sticker.', color: PALETTE.green, weight: 15, quantity: 100, isPrize: true },
    ],
  };
}

/** Starter game for a newly created company: the same wheel, worded for that company. */
export function newCompanyConfig(companyName) {
  const config = defaultConfig();
  config.branding.tagline = `Spin the wheel for a little something from ${companyName}.`;
  config.branding.instructions[2] = 'If you land on a gift, show your claim code to a member of our team.';
  for (const seg of config.segments) {
    seg.description = seg.description.replace(/PharmKulen /g, '');
  }
  return config;
}
