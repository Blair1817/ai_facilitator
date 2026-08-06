import React, { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";

// Global, one-time captcha check. The task-specific Review Quiz now runs once
// per Round in client/src/stages/ReviewQuiz.jsx.
export function AttentionCheck({ previous, next }) {
  const inputClassName =
    "appearance-none block w-full py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-empirica-500 focus:border-empirica-500 sm:text-sm";
  const [captcha, setCaptcha] = useState("");
  const [captchaMessage, setCaptchaMessage] = useState("");
  const canvasRef = useRef(null);

  const generateCaptchaCheck = () => {
    let captchaText = "";
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 4; i += 1) {
      captchaText += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    setCaptchaMessage(captchaText);
  };

  useEffect(() => {
    generateCaptchaCheck();
  }, []);

  useEffect(() => {
    if (!canvasRef.current || !captchaMessage) {
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "30px Arial";
    ctx.fillStyle = "black";
    ctx.fillText(captchaMessage, 10, 50);
    ctx.beginPath();
    ctx.moveTo(0, 40);
    ctx.lineTo(80, 40);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "black";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 40);
    ctx.lineTo(80, 30);
    ctx.stroke();
  }, [captchaMessage]);

  const handleSubmit = (event) => {
    event.preventDefault();
    if (captcha === captchaMessage) {
      next();
      return;
    }
    alert("The code is incorrect. Please review it and try again.");
  };

  return (
    <div className="flex w-full px-30% items-center justify-center mt-5%">
      <form className="divide-y divide-gray-200" onSubmit={handleSubmit}>
        <div>
          <h3 className="text-lg font-medium text-gray-900">Security Check</h3>
          <p className="mt-1 text-sm text-gray-500">
            Please enter the code below before proceeding to the experiment.
          </p>

          <div className="mt-6">
            <label className="block text-sm font-medium text-gray-700 my-2">
              Please input the code that appears below (case sensitive):
            </label>
            <div className="flex items-center">
              <canvas ref={canvasRef} height="75" width="100" />
              <button
                type="button"
                onClick={generateCaptchaCheck}
                className="ml-4 px-3 py-1 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-empirica-500"
              >
                Regenerate Captcha
              </button>
            </div>
            <input
              id="captcha"
              name="captcha"
              type="text"
              autoComplete="off"
              placeholder="Enter the code above"
              className={inputClassName}
              value={captcha}
              onChange={(event) => setCaptcha(event.target.value)}
            />
          </div>

          <div className="flex justify-between mt-8">
            <Button handleClick={previous}>Previous</Button>
            <Button type="submit">Proceed to experiment</Button>
          </div>
        </div>
      </form>
    </div>
  );
}
