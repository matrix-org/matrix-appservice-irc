const defaultTheme = require('tailwindcss/defaultTheme');

/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        './widget/index.html',
        './widget/src/**/*.{js,ts,jsx,tsx}',
    ],
    theme: {
        extend: {
            colors: {
                // Light theme
                'green': '#0dbd8b',
                'green-alt': '#0ecf98',
                'red': '#ff5b55',
                'red-alt': '#ff8282',
                'blue': '#0086e6',
                'black-900': '#17191c',
                'grey-200': '#737d8c',
                'grey-150': '#8d97a5',
                'grey-100': '#c1c6cd',
                'grey-50': '#e3e8f0',
                'grey-25': '#f4f6fa',
                'white': '#ffffff',
            },
            fontFamily: {
                sans: [
                    "'Inter'",
                    ...defaultTheme.fontFamily.sans,
                ],
            },
        },
    },
    darkMode: 'class',
    plugins: [
        require('@tailwindcss/forms'),
    ],
};
