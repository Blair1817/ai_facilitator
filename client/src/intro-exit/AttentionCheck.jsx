import { usePlayer, useGame } from "@empirica/core/player/classic/react";
import React, { useState, useEffect, useRef } from "react";
import { Alert } from "../components/Alert";
import { Button } from "../components/Button";

export function AttentionCheck({ previous, next }) {
  const labelClassName = "block text-sm font-medium text-gray-700 my-2";
  const inputClassName =
    "appearance-none block w-full py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-empirica-500 focus:border-empirica-500 sm:text-sm";
  const player = usePlayer();
  const game = useGame();
  const {facilitation, playerCount} = game.get("treatment"); 

  // Define state variables for each question
  const [question1, setQuestion1] = useState("");
  const [question2, setQuestion2] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [captchaMessage, setCaptchaMessage] = useState("");
  const canvasRef = useRef(null);

  useEffect(() => {
    generateCaptchaCheck();
  }, []);

  useEffect(() => {
    if (canvasRef.current && captchaMessage) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (ctx) {
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
        ctx.lineWidth = 2;
        ctx.strokeStyle = "black";
        ctx.stroke();
      }
    }
  }, [captchaMessage]);

  const generateCaptchaCheck = () => {
    let captcha_text = "";
    const c_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 1; i < 5; i++) {
      captcha_text += c_chars.charAt(Math.random() * c_chars.length);
    }
    setCaptchaMessage(captcha_text);
  };

  function handleSubmit(event) {
    event.preventDefault();

    if (parseInt(question1) == playerCount-1 && question2 == "option3" && captcha == captchaMessage) {
      next();
    }
    else{
      alert("One or more answers are incorrect. Please review your answers and try again.");
    }
  }

  return (
    <div className="flex w-full px-30% items-center justify-center mt-5%">
      <form
        className="divide-y divide-gray-200"
        onSubmit={handleSubmit}
      >
        <div className="divide-y divide-gray-200">
          <div>
            <div>
              <h3 className="text-lg font-medium text-gray-900">
                Review Quiz
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                Please complete this quiz to confirm that you've understood the task before proceeding.
              </p>
            </div>

            <div className="space-y-8 mt-6">
              <div>
                <label htmlFor="question1" className={labelClassName}>
                  There are a total of {playerCount} members in the committee, including you. How many members are in the committee other than yourself?
                </label>
                <div className="mt-1">
                  <input
                    id="question1"
                    name="question1"
                    type="number"
                    autoComplete="off"
                    placeholder="Enter a number"
                    className={inputClassName}
                    value={question1}
                    onChange={(e) => setQuestion1(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className={labelClassName}>The objective of the committee's discussion is to:</label>
                <div className="grid gap-2">
                  <Radio
                    selected={question2}
                    name="question2"
                    value="option1"
                    label="Rate sports facilities in each city."
                    onChange={(e) => setQuestion2(e.target.value)}
                  />
                  <Radio
                    selected={question2}
                    name="question2"
                    value="option2"
                    label="Compare cities to determine which is most deserving of an infrastructure grant."
                    onChange={(e) => setQuestion2(e.target.value)}
                  />
                  <Radio
                    selected={question2}
                    name="question2"
                    value="option3"
                    label="Select the most suitable city to host the next event from the International Sports Federation."
                    onChange={(e) => setQuestion2(e.target.value)}
                  />
                  <Radio
                    selected={question2}
                    name="question2"
                    value="option4"
                    label="None of the above."
                    onChange={(e) => setQuestion2(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className={labelClassName}>Please input the code that appears below (case sensitive):</label>
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
              <div className="mt-1">
                  <input
                    id="captcha"
                    name="captcha"
                    type="text"
                    autoComplete="off"
                    placeholder="Enter the code above"
                    className={inputClassName}
                    value={captcha}
                    onChange={(e) => setCaptcha(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex justify-between">
                <div className="text-left">
                  <Button handleClick={previous} autoFocus>
                    <p>Previous</p>
                  </Button>
                </div>
                <div className="text-right">
                  <Button handleClick={handleSubmit} autoFocus>
                    <p>Proceed to task</p>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

export function Radio({ selected, name, value, label, onChange }) {
  return (
    <label className="text-sm font-medium text-gray-700">
      <input
        className="mr-2 shadow-sm sm:text-sm"
        type="radio"
        name={name}
        value={value}
        checked={selected === value}
        onChange={onChange}
      />
      {label}
    </label>
  );
}



